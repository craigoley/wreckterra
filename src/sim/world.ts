import {
  CONTRACT_VERSION,
  MAX_STEPS_PER_ADVANCE,
  TICK_SECONDS,
  type ArenaLayout,
  type InputCommand,
  type InputResult,
  type LocalAuthority,
  type Obstacle,
  type SimEvent,
  type Snapshot,
  type VehicleState,
} from "./contracts";
import { closestOnSegment, pointInRing, type CityData, type Vec2 } from "../maps/city-compiler";
import { cityContacts, cityIndexFor, cityOnRoad, type Contact, type Footprint } from "../maps/midtown";

export interface WorldOptions {
  seed: number;
  playerId?: string;
  /** Top speed in metres per second. */
  maxSpeed?: number;
}

const ARENA_HALF_EXTENT = 40;
const VEHICLE_RADIUS = 1.2;
const OBSTACLE_COUNT = 9;
const ACCELERATION = 14;
const BRAKE_DECELERATION = 26;
const DRAG = 0.6;
const TURN_RATE = 2.2;
const WALL_SPEED_KEPT = 0.35;
const IMPACT_MIN_SPEED = 3;

/** Small seeded PRNG (mulberry32): the only source of randomness the simulation may use. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildLayout(rng: () => number): ArenaLayout {
  const obstacles: Obstacle[] = [];
  while (obstacles.length < OBSTACLE_COUNT) {
    const x = (rng() * 2 - 1) * (ARENA_HALF_EXTENT - 6);
    const z = (rng() * 2 - 1) * (ARENA_HALF_EXTENT - 6);
    const halfX = 1.2 + rng() * 2.4;
    const halfZ = 1.2 + rng() * 2.4;
    // Keep the spawn area at the centre clear.
    if (Math.hypot(x, z) - Math.max(halfX, halfZ) < 8) continue;
    obstacles.push({ x, z, halfX, halfZ });
  }
  return { halfExtent: ARENA_HALF_EXTENT, obstacles };
}

function isFiniteIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validateInput(raw: unknown, playerId: string): { ok: true; input: InputCommand } | { ok: false; result: InputResult } {
  const reject = (reason: "bad-shape" | "bad-version" | "out-of-range" | "unknown-player") => ({
    ok: false as const,
    result: { accepted: false as const, reason },
  });
  if (typeof raw !== "object" || raw === null) return reject("bad-shape");
  const c = raw as Record<string, unknown>;
  if (c.v !== CONTRACT_VERSION) return reject(c.v === undefined ? "bad-shape" : "bad-version");
  if (typeof c.playerId !== "string" || typeof c.brake !== "boolean" || typeof c.tick !== "number") return reject("bad-shape");
  if (c.playerId !== playerId) return reject("unknown-player");
  if (!isFiniteIn(c.steer, -1, 1) || !isFiniteIn(c.throttle, -1, 1) || !Number.isInteger(c.tick) || c.tick < 0) {
    return reject("out-of-range");
  }
  return { ok: true, input: { v: CONTRACT_VERSION, tick: c.tick, playerId, steer: c.steer, throttle: c.throttle, brake: c.brake } };
}

/** Push a circle out of an axis-aligned box. Returns true when contact was resolved. */
export function resolveBox(vehicle: { x: number; z: number }, box: Obstacle, radius: number = VEHICLE_RADIUS): boolean {
  const dx = vehicle.x - box.x;
  const dz = vehicle.z - box.z;
  const nearestX = Math.max(-box.halfX, Math.min(box.halfX, dx));
  const nearestZ = Math.max(-box.halfZ, Math.min(box.halfZ, dz));
  const gx = dx - nearestX;
  const gz = dz - nearestZ;
  const distance = Math.hypot(gx, gz);
  if (distance >= radius) return false;
  if (distance > 0) {
    const push = (radius - distance) / distance;
    vehicle.x += gx * push;
    vehicle.z += gz * push;
  } else {
    // Centre is inside the box: leave through the shallowest face.
    const outX = box.halfX - Math.abs(dx);
    const outZ = box.halfZ - Math.abs(dz);
    if (outX < outZ) vehicle.x += (dx >= 0 ? 1 : -1) * (outX + radius);
    else vehicle.z += (dz >= 0 ? 1 : -1) * (outZ + radius);
  }
  return true;
}

/**
 * Create a local-authority world. Pure TypeScript: no React, DOM, timers or renderer, so it can
 * be driven by a test, a render loop or (later) a server tick with identical results.
 */
export function createWorld(options: WorldOptions): LocalAuthority {
  const { seed } = options;
  const playerId = options.playerId ?? "player-1";
  const maxSpeed = options.maxSpeed ?? 20;
  const rng = createRng(seed);
  const layout = buildLayout(rng);
  const vehicle: VehicleState = { playerId, x: 0, z: 0, heading: rng() * Math.PI * 2, speed: 0 };
  let input: InputCommand = { v: CONTRACT_VERSION, tick: 0, playerId, steer: 0, throttle: 0, brake: false };
  let tick = 0;
  let accumulator = 0;
  let impactedLastTick = false;
  let disposed = false;
  let events: SimEvent[] = [{ v: CONTRACT_VERSION, tick: 0, kind: "spawned", playerId }];

  function step(): void {
    tick += 1;
    let speed = vehicle.speed;
    speed += input.throttle * ACCELERATION * TICK_SECONDS;
    if (input.brake) {
      const slowed = BRAKE_DECELERATION * TICK_SECONDS;
      speed = Math.abs(speed) <= slowed ? 0 : speed - Math.sign(speed) * slowed;
    }
    speed -= speed * DRAG * TICK_SECONDS;
    speed = Math.max(-maxSpeed * 0.4, Math.min(maxSpeed, speed));

    const grip = Math.max(-1, Math.min(1, speed / (maxSpeed * 0.3)));
    vehicle.heading -= input.steer * TURN_RATE * grip * TICK_SECONDS;
    vehicle.x += Math.sin(vehicle.heading) * speed * TICK_SECONDS;
    vehicle.z += Math.cos(vehicle.heading) * speed * TICK_SECONDS;

    let hit = false;
    const limit = layout.halfExtent - VEHICLE_RADIUS;
    if (Math.abs(vehicle.x) > limit) {
      vehicle.x = Math.sign(vehicle.x) * limit;
      hit = true;
    }
    if (Math.abs(vehicle.z) > limit) {
      vehicle.z = Math.sign(vehicle.z) * limit;
      hit = true;
    }
    for (const box of layout.obstacles) hit = resolveBox(vehicle, box) || hit;

    if (hit) {
      if (!impactedLastTick && Math.abs(speed) >= IMPACT_MIN_SPEED) {
        events.push({ v: CONTRACT_VERSION, tick, kind: "impact", playerId, speed: Math.abs(speed) });
      }
      speed *= WALL_SPEED_KEPT;
    }
    impactedLastTick = hit;
    vehicle.speed = speed;
  }

  return {
    layout,
    submitInput(raw) {
      const checked = validateInput(raw, playerId);
      if (!checked.ok) return checked.result;
      input = checked.input;
      return { accepted: true };
    },
    advance(elapsedSeconds) {
      if (disposed || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return 0;
      accumulator += elapsedSeconds;
      let steps = Math.floor(accumulator / TICK_SECONDS + 1e-9);
      if (steps > MAX_STEPS_PER_ADVANCE) {
        // A stall (hidden tab, long frame) must not replay as a burst: drop the backlog.
        steps = MAX_STEPS_PER_ADVANCE;
        accumulator = 0;
      } else {
        accumulator = Math.max(0, accumulator - steps * TICK_SECONDS);
      }
      for (let i = 0; i < steps; i += 1) step();
      return steps;
    },
    snapshot(): Snapshot {
      return { v: CONTRACT_VERSION, tick, seed, vehicles: [{ ...vehicle }] };
    },
    drainEvents() {
      const drained = events;
      events = [];
      return drained;
    },
    dispose() {
      disposed = true;
    },
  };
}

export interface FrameScheduler {
  request(callback: (timeMs: number) => void): number;
  cancel(handle: number): void;
}

export interface LoopOptions {
  scheduler?: FrameScheduler;
  /** Called before each advance so the caller can sample controls and submit an input. */
  sample?: (world: LocalAuthority) => void;
  /** Called after each advance with the newest snapshot. */
  onFrame?: (snapshot: Snapshot) => void;
}

export interface LoopHandle {
  pause(): void;
  /** Resume without replaying the paused interval. */
  resume(): void;
  stop(): void;
  readonly running: boolean;
}

/** Events travel from the simulation loop to a renderer through one of these. */
export interface EventBus { events: SimEvent[] }
/** Keep the bus from growing while nothing is drawing (no WebGL, a hidden tab). */
export const EVENT_BUS_LIMIT = 256;

export function pushEvents(bus: EventBus, events: readonly SimEvent[]): void {
  if (events.length === 0) return;
  bus.events.push(...events);
  if (bus.events.length > EVENT_BUS_LIMIT) bus.events.splice(0, bus.events.length - EVENT_BUS_LIMIT);
}

let liveLoops = 0;
/** Number of simulation loops currently scheduled; a mount/unmount leak shows up here. */
export function activeLoopCount(): number {
  return liveLoops;
}

function defaultScheduler(): FrameScheduler {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return {
      request: (cb) => globalThis.requestAnimationFrame(cb),
      cancel: (h) => globalThis.cancelAnimationFrame(h),
    };
  }
  return {
    request: (cb) => setTimeout(() => cb(Date.now()), 1000 / 60) as unknown as number,
    cancel: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
  };
}

/** Drive a world from animation frames. `stop` is idempotent and releases the loop slot. */
export function startLoop(world: LocalAuthority, options: LoopOptions = {}): LoopHandle {
  const scheduler = options.scheduler ?? defaultScheduler();
  let handle: number | undefined;
  let last: number | undefined;
  let stopped = false;
  let paused = false;
  liveLoops += 1;

  const frame = (timeMs: number): void => {
    handle = undefined;
    if (stopped || paused) return;
    const elapsed = last === undefined ? 0 : (timeMs - last) / 1000;
    last = timeMs;
    options.sample?.(world);
    world.advance(elapsed);
    options.onFrame?.(world.snapshot());
    handle = scheduler.request(frame);
  };
  const cancelPending = (): void => {
    if (handle !== undefined) scheduler.cancel(handle);
    handle = undefined;
  };

  handle = scheduler.request(frame);
  return {
    pause() {
      if (stopped || paused) return;
      paused = true;
      cancelPending();
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      last = undefined;
      handle = scheduler.request(frame);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cancelPending();
      liveLoops -= 1;
    },
    get running() {
      return !stopped && !paused;
    },
  };
}

/* ---------------------------------------------------------------- the city as a solid place */

/** Distance along a unit ray to one polygon edge, or Infinity when the ray misses it. */
function rayEdge(ox: number, oz: number, dx: number, dz: number, a: Vec2, b: Vec2): number {
  const ex = b[0] - a[0];
  const ez = b[1] - a[1];
  const denominator = dx * ez - dz * ex;
  if (Math.abs(denominator) < 1e-12) return Infinity;
  const ax = a[0] - ox;
  const az = a[1] - oz;
  const t = (ax * ez - az * ex) / denominator;
  const u = (ax * dz - az * dx) / denominator;
  return t >= 0 && u >= 0 && u <= 1 ? t : Infinity;
}

export interface CityGeometry {
  /**
   * Distance along a unit ray to the first building wall: 0 when the ray starts inside a building,
   * Infinity when the way is open. Walls are the real footprint edges, so a notch in an L-shaped
   * block is open air and a shot cannot pass through the solid part.
   */
  rayCover(ox: number, oz: number, dx: number, dz: number): number;
  /** True when no building wall lies on the straight line between two points. */
  clear(ax: number, az: number, bx: number, bz: number): boolean;
  /** True when a point is inside a building. */
  solidAt(x: number, z: number): boolean;
  /** Every building a circle overlaps, as push-out contacts. */
  contacts(x: number, z: number, radius: number): Contact[];
  /** Distance to the nearest building wall, 0 inside one, capped at `cap`. */
  wallDistance(x: number, z: number, cap: number): number;
  /** True when a point is on a carriageway (a little generous at the kerb). */
  onRoad(x: number, z: number): boolean;
  /** Distance from a point to the nearest road centre line. */
  roadDistance(x: number, z: number): number;
}

/**
 * Index a city's buildings and roads for the combat simulation. Pure geometry with no clock and no
 * randomness; a uniform grid (built once per city) hands each query only the buildings and road
 * segments in the cells it touches, so the cost of a query does not grow with the size of the district.
 */
export function createCityGeometry(city: CityData): CityGeometry {
  const index = cityIndexFor(city);
  const { footprints, buildings, segments, roads } = index;
  const near = (f: Footprint, x: number, z: number, margin: number): boolean => x >= f.minX - margin && x <= f.maxX + margin && z >= f.minZ - margin && z <= f.maxZ + margin;

  /** Does the ray touch the footprint's bounding box within `limit` metres? */
  const rayHitsBox = (f: Footprint, ox: number, oz: number, dx: number, dz: number, limit: number): boolean => {
    let near0 = 0;
    let far0 = limit;
    for (const [origin, dir, lo, hi] of [[ox, dx, f.minX, f.maxX], [oz, dz, f.minZ, f.maxZ]] as const) {
      if (Math.abs(dir) < 1e-12) {
        if (origin < lo || origin > hi) return false;
        continue;
      }
      const t1 = (lo - origin) / dir;
      const t2 = (hi - origin) / dir;
      near0 = Math.max(near0, Math.min(t1, t2));
      far0 = Math.min(far0, Math.max(t1, t2));
      if (near0 > far0) return false;
    }
    return true;
  };

  /** The nearest wall within `limit` metres along a unit ray (0 from inside a building), else `limit`. */
  const cover = (ox: number, oz: number, dx: number, dz: number, limit: number): number => {
    let nearest = limit;
    buildings.along(ox, oz, dx, dz, limit, (id) => {
      const f = footprints[id]!;
      if (!rayHitsBox(f, ox, oz, dx, dz, nearest)) return nearest;
      if (near(f, ox, oz, 0) && pointInRing([ox, oz], f.ring)) { nearest = 0; return 0; }
      for (let i = 0; i < f.ring.length; i += 1) nearest = Math.min(nearest, rayEdge(ox, oz, dx, dz, f.ring[i]!, f.ring[(i + 1) % f.ring.length]!));
      return nearest;
    });
    return nearest;
  };
  const solidAt = (x: number, z: number): boolean => buildings.query(x, z, x, z).some((id) => pointInRing([x, z], footprints[id]!.ring));
  const roadDistance = (x: number, z: number): number => {
    // Widen the search until a segment is found inside it: that one is then the nearest.
    for (let reach = 24; ; reach *= 2) {
      let best = Infinity;
      for (const id of roads.query(x - reach, z - reach, x + reach, z + reach)) {
        const s = segments[id]!;
        const c = closestOnSegment([x, z], s.a, s.b);
        best = Math.min(best, Math.hypot(x - c[0], z - c[1]));
      }
      if (best <= reach) return best;
      if (reach > 1e6) return best;
    }
  };

  return {
    rayCover: (ox, oz, dx, dz) => cover(ox, oz, dx, dz, Infinity),
    clear(ax, az, bx, bz) {
      const length = Math.hypot(bx - ax, bz - az);
      return length < 1e-6 || cover(ax, az, (bx - ax) / length, (bz - az) / length, length) >= length;
    },
    solidAt,
    contacts: (x, z, radius) => cityContacts(index, x, z, radius),
    wallDistance(x, z, cap) {
      let best = cap;
      for (const id of buildings.query(x - cap, z - cap, x + cap, z + cap)) {
        const f = footprints[id]!;
        if (!near(f, x, z, best)) continue;
        if (pointInRing([x, z], f.ring)) return 0;
        for (let i = 0; i < f.ring.length; i += 1) {
          const c = closestOnSegment([x, z], f.ring[i]!, f.ring[(i + 1) % f.ring.length]!);
          best = Math.min(best, Math.hypot(x - c[0], z - c[1]));
        }
      }
      return best;
    },
    onRoad: (x, z) => cityOnRoad(index, x, z),
    roadDistance,
  };
}
