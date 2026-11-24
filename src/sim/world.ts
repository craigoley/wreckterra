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
function resolveBox(vehicle: VehicleState, box: Obstacle): boolean {
  const dx = vehicle.x - box.x;
  const dz = vehicle.z - box.z;
  const nearestX = Math.max(-box.halfX, Math.min(box.halfX, dx));
  const nearestZ = Math.max(-box.halfZ, Math.min(box.halfZ, dz));
  const gx = dx - nearestX;
  const gz = dz - nearestZ;
  const distance = Math.hypot(gx, gz);
  if (distance >= VEHICLE_RADIUS) return false;
  if (distance > 0) {
    const push = (VEHICLE_RADIUS - distance) / distance;
    vehicle.x += gx * push;
    vehicle.z += gz * push;
  } else {
    // Centre is inside the box: leave through the shallowest face.
    const outX = box.halfX - Math.abs(dx);
    const outZ = box.halfZ - Math.abs(dz);
    if (outX < outZ) vehicle.x += (dx >= 0 ? 1 : -1) * (outX + VEHICLE_RADIUS);
    else vehicle.z += (dz >= 0 ? 1 : -1) * (outZ + VEHICLE_RADIUS);
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
