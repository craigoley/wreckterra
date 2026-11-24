/**
 * Midtown: loads the compiled city and drives one car through it on the fixed-tick contract.
 * Nothing here imports React, the DOM or a renderer, so the city world can be driven by a test,
 * a render loop or (later) a server tick with identical results.
 */
import { VEHICLE_SPECS } from "../sim/arena";
import {
  CONTRACT_VERSION,
  MAX_STEPS_PER_ADVANCE,
  TICK_SECONDS,
  type ArenaLayout,
  type InputCommand,
  type InputResult,
  type LocalAuthority,
  type SimEvent,
  type Snapshot,
  type VehicleKind,
  type VehicleState,
} from "../sim/contracts";
import type { LatLon } from "./city-cache";
import { CITY_VERSION, closestOnSegment, pointInRing, signedArea, type CityData, type Vec2 } from "./city-compiler";
import type { CityGeometry } from "../sim/world";
import { createSpatialIndex, type SpatialIndex } from "./spatial-index";
import { loadLiveCity, type LiveCityDeps } from "./tile-city";

/** The compiled city is a static file served from our own origin: production never calls Overpass. */
export const CITY_URL = `${import.meta.env.BASE_URL}maps/midtown/city.json`;

function isPair(value: unknown): value is Vec2 {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** Validate a parsed city file. Throws a readable error rather than letting bad data reach the sim. */
export function parseCity(raw: unknown): CityData {
  const fail = (what: string): never => { throw new Error(`The city file is not usable: ${what}.`); };
  if (typeof raw !== "object" || raw === null) return fail("it is not an object");
  const city = raw as CityData;
  if (city.version !== CITY_VERSION) fail(`version ${String(city.version)} is not supported`);
  for (const key of ["buildings", "roads", "sidewalks", "parks", "trees", "lamps", "spawns"] as const) {
    if (!Array.isArray(city[key])) fail(`"${key}" is missing`);
  }
  const bounds = city.bounds;
  if (!bounds || ![bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(Number.isFinite)) fail("its bounds are not finite");
  if (!city.graph || !Array.isArray(city.graph.nodes) || !Array.isArray(city.graph.edges)) fail("its street graph is missing");
  for (const b of city.buildings) {
    if (!Array.isArray(b.footprint) || b.footprint.length < 3 || !b.footprint.every(isPair)) fail(`building ${b.id} has a bad footprint`);
    if (!Number.isFinite(b.height) || b.height <= 0) fail(`building ${b.id} has a bad height`);
  }
  for (const r of city.roads) {
    if (!Array.isArray(r.points) || r.points.length < 2 || !r.points.every(isPair) || !Number.isFinite(r.width)) fail(`road ${r.id} is malformed`);
  }
  if (!city.spawns.every((s) => Number.isFinite(s.x) && Number.isFinite(s.z) && Number.isFinite(s.heading))) fail("a spawn is not finite");
  if (!city.source || typeof city.source.attribution !== "string") fail("its source receipt is missing");
  // The collision code relies on one winding order.
  return { ...city, buildings: city.buildings.map((b) => (signedArea(b.footprint) > 0 ? b : { ...b, footprint: [...b.footprint].reverse() })) };
}

export async function loadCity(url: string = CITY_URL, fetchImpl: typeof fetch = fetch): Promise<CityData> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`The city file could not be loaded (HTTP ${response.status}).`);
  return parseCity(await response.json());
}

/** What the game plays in: a live city from map tiles, or the pinned city with the reason it stood in. */
export interface PlayableCity { city: CityData; live: boolean; reason: string | null }

export interface PlayableCityOptions {
  /** Tile fetching and caching; defaults to OpenFreeMap tiles and the IndexedDB cache. */
  live?: LiveCityDeps;
  /** Loader for the pinned city; defaults to `loadCity`. */
  pinned?: () => Promise<CityData>;
}

async function browserLiveDeps(): Promise<LiveCityDeps> {
  // Loaded on demand so the tile decoder stays out of the pinned-city path.
  const [{ fetchTileFeatures }, { createIndexedDbStore }] = await Promise.all([import("./live-tiles"), import("./city-cache")]);
  return { fetchTiles: (request) => fetchTileFeatures(request), cache: createIndexedDbStore() };
}

/**
 * Load a city for a picked place beside the pinned loader: a live city built from map tiles when
 * they can be had, otherwise the pinned Midtown city together with why. No geometry is invented.
 */
export async function loadPlayableCity(point: LatLon, options: PlayableCityOptions = {}): Promise<PlayableCity> {
  let reason: string;
  try {
    const outcome = await loadLiveCity(point, options.live ?? (await browserLiveDeps()));
    if (outcome.ok) return { city: outcome.city, live: true, reason: null };
    reason = outcome.reason;
  } catch (error) {
    reason = `Live map tiles are not available (${error instanceof Error ? error.message : String(error)}). The pinned Midtown city is offered instead.`;
  }
  return { city: await (options.pinned ?? (() => loadCity()))(), live: false, reason };
}

/* ---------------------------------------------------------------- collision */

export interface Contact { nx: number; nz: number; depth: number }

/**
 * Where a circle overlaps a building footprint: the unit normal pointing out of the building and
 * how far to move along it to clear the wall, or null when they do not touch. The ring must have a
 * positive shoelace area (the compiler and `parseCity` guarantee it). Works for concave footprints.
 */
export function circleVsFootprint(x: number, z: number, radius: number, ring: readonly Vec2[]): Contact | null {
  const p: Vec2 = [x, z];
  let best = Infinity;
  let bestEdge = 0;
  let bestPoint: Vec2 = [0, 0];
  for (let i = 0; i < ring.length; i += 1) {
    const c = closestOnSegment(p, ring[i]!, ring[(i + 1) % ring.length]!);
    const d = Math.hypot(x - c[0], z - c[1]);
    if (d < best) { best = d; bestEdge = i; bestPoint = c; }
  }
  const inside = pointInRing(p, ring);
  if (!inside && best >= radius) return null;
  if (inside || best < 1e-9) {
    const a = ring[bestEdge]!;
    const b = ring[(bestEdge + 1) % ring.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return { nx: (b[1] - a[1]) / len, nz: -(b[0] - a[0]) / len, depth: (inside ? best : 0) + radius };
  }
  return { nx: (x - bestPoint[0]) / best, nz: (z - bestPoint[1]) / best, depth: radius - best };
}

/* ---------------------------------------------------------------- the indexed city */

/** Cell edge of the collision grids, metres: a block or two, so a query touches a few buildings. */
const INDEX_CELL_M = 16;
/** A street counts as carriageway this far past its half width (generous at the kerb). */
const KERB_M = 0.4;

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

/** The city geometry plus a ray test that gives up past a distance, which is all a sight line needs. */
export interface IndexedGeometry extends CityGeometry {
  /** Like `rayCover`, but anything farther than `limit` along the ray is ignored (Infinity when none is nearer). */
  rayCoverWithin(ox: number, oz: number, dx: number, dz: number, limit: number): number;
}

interface Footprint { ring: readonly Vec2[]; minX: number; maxX: number; minZ: number; maxZ: number }
interface RoadSegment { a: Vec2; b: Vec2; half: number }

/**
 * A city's buildings and street segments filed in uniform grids, built once per city. Car collision,
 * the on-road test, line of sight and bot steering query only the cells they touch, and answer
 * exactly what a scan of every building and segment would (contacts come back in building order).
 */
export function createIndexedGeometry(city: CityData): IndexedGeometry {
  const footprints: Footprint[] = city.buildings.map((b) => {
    const xs = b.footprint.map((p) => p[0]);
    const zs = b.footprint.map((p) => p[1]);
    return { ring: b.footprint, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  });
  const segments: RoadSegment[] = city.roads.flatMap((r) => r.points.slice(1).map((p, i) => ({ a: r.points[i]!, b: p, half: r.width / 2 + KERB_M })));
  const bounds = {
    minX: Math.min(city.bounds.minX, ...footprints.map((f) => f.minX), ...segments.map((s) => Math.min(s.a[0], s.b[0]) - s.half)),
    maxX: Math.max(city.bounds.maxX, ...footprints.map((f) => f.maxX), ...segments.map((s) => Math.max(s.a[0], s.b[0]) + s.half)),
    minZ: Math.min(city.bounds.minZ, ...footprints.map((f) => f.minZ), ...segments.map((s) => Math.min(s.a[1], s.b[1]) - s.half)),
    maxZ: Math.max(city.bounds.maxZ, ...footprints.map((f) => f.maxZ), ...segments.map((s) => Math.max(s.a[1], s.b[1]) + s.half)),
  };
  const buildingGrid: SpatialIndex = createSpatialIndex(bounds, INDEX_CELL_M, footprints.length);
  footprints.forEach((f, i) => buildingGrid.insert(i, f.minX, f.minZ, f.maxX, f.maxZ));
  const roadGrid: SpatialIndex = createSpatialIndex(bounds, INDEX_CELL_M, segments.length);
  segments.forEach((s, i) => roadGrid.insert(i, Math.min(s.a[0], s.b[0]) - s.half, Math.min(s.a[1], s.b[1]) - s.half, Math.max(s.a[0], s.b[0]) + s.half, Math.max(s.a[1], s.b[1]) + s.half));

  const near = (f: Footprint, x: number, z: number, margin: number): boolean => x >= f.minX - margin && x <= f.maxX + margin && z >= f.minZ - margin && z <= f.maxZ + margin;
  const segmentDistance = (s: RoadSegment, x: number, z: number): number => {
    const c = closestOnSegment([x, z], s.a, s.b);
    return Math.hypot(x - c[0], z - c[1]);
  };

  /** Does the ray touch the footprint's bounding box within `limit` metres? */
  const rayHitsBox = (f: Footprint, ox: number, oz: number, dx: number, dz: number, limit: number): boolean => {
    let enter = 0;
    let leave = limit;
    for (const [origin, dir, lo, hi] of [[ox, dx, f.minX, f.maxX], [oz, dz, f.minZ, f.maxZ]] as const) {
      if (Math.abs(dir) < 1e-12) {
        if (origin < lo || origin > hi) return false;
        continue;
      }
      const t1 = (lo - origin) / dir;
      const t2 = (hi - origin) / dir;
      enter = Math.max(enter, Math.min(t1, t2));
      leave = Math.min(leave, Math.max(t1, t2));
      if (enter > leave) return false;
    }
    return true;
  };

  /** The nearest wall along a ray, ignoring anything past `limit` (so a short sight line stops early). */
  const coverWithin = (ox: number, oz: number, dx: number, dz: number, limit: number): number => {
    let nearest = Infinity;
    let inside = false;
    buildingGrid.ray(ox, oz, dx, dz, limit, (id) => {
      const f = footprints[id]!;
      if (inside || !rayHitsBox(f, ox, oz, dx, dz, nearest)) return nearest;
      if (near(f, ox, oz, 0) && pointInRing([ox, oz], f.ring)) {
        inside = true;
        return 0;
      }
      for (let i = 0; i < f.ring.length; i += 1) nearest = Math.min(nearest, rayEdge(ox, oz, dx, dz, f.ring[i]!, f.ring[(i + 1) % f.ring.length]!));
      return nearest;
    });
    return inside ? 0 : nearest > limit ? Infinity : nearest;
  };
  const rayCover = (ox: number, oz: number, dx: number, dz: number): number => coverWithin(ox, oz, dx, dz, Infinity);

  return {
    rayCover,
    rayCoverWithin: coverWithin,
    clear(ax, az, bx, bz) {
      const length = Math.hypot(bx - ax, bz - az);
      return length < 1e-6 || coverWithin(ax, az, (bx - ax) / length, (bz - az) / length, length) >= length;
    },
    solidAt(x, z) {
      let solid = false;
      buildingGrid.query(x, z, x, z, (id) => {
        const f = footprints[id]!;
        if (!solid && near(f, x, z, 0) && pointInRing([x, z], f.ring)) solid = true;
      });
      return solid;
    },
    contacts(x, z, radius) {
      const out: Contact[] = [];
      for (const id of buildingGrid.collect(x - radius, z - radius, x + radius, z + radius)) {
        const f = footprints[id]!;
        if (!near(f, x, z, radius)) continue;
        const contact = circleVsFootprint(x, z, radius, f.ring);
        if (contact) out.push(contact);
      }
      return out;
    },
    wallDistance(x, z, cap) {
      let best = cap;
      let inside = false;
      buildingGrid.query(x - cap, z - cap, x + cap, z + cap, (id) => {
        const f = footprints[id]!;
        if (inside || !near(f, x, z, cap)) return;
        if (pointInRing([x, z], f.ring)) {
          inside = true;
          return;
        }
        for (let i = 0; i < f.ring.length; i += 1) {
          const c = closestOnSegment([x, z], f.ring[i]!, f.ring[(i + 1) % f.ring.length]!);
          best = Math.min(best, Math.hypot(x - c[0], z - c[1]));
        }
      });
      return inside ? 0 : best;
    },
    onRoad(x, z) {
      let on = false;
      roadGrid.query(x, z, x, z, (id) => {
        const s = segments[id]!;
        if (!on && segmentDistance(s, x, z) <= s.half) on = true;
      });
      return on;
    },
    roadDistance(x, z) {
      const found = roadGrid.nearest(x, z, (id) => segmentDistance(segments[id]!, x, z));
      return found ? found.distance : Infinity;
    },
  };
}

/* ---------------------------------------------------------------- the city world */

export interface CityVehicleState extends VehicleState {
  kind: VehicleKind;
  /** Sideways speed in m/s; non-zero while the car slides. */
  lateral: number;
  /** True while the car is on a sidewalk or in the park rather than on a road. */
  offRoad: boolean;
}

export interface CitySnapshot extends Snapshot {
  vehicles: readonly CityVehicleState[];
}

export interface CityAuthority extends LocalAuthority {
  readonly city: CityData;
  snapshot(): CitySnapshot;
  /** Put the car back on a road spawn and stop it. */
  reset(spawnIndex?: number): void;
}

export interface CityWorldOptions {
  seed: number;
  vehicle?: VehicleKind;
  playerId?: string;
  spawnIndex?: number;
}

/** Arcade tuning: the arena speeds scaled up so a block takes seconds, not a minute. */
export const CITY_SPEED_SCALE = 1.6;
export const CITY_ACCEL_SCALE = 1.5;
const BRAKE_DECELERATION = 38;
const DRAG = 0.35;
const OFFROAD_DRAG = 1.6;
const OFFROAD_SPEED_KEPT = 0.6;
const GRIP_RATE = 7;
const DRIFT_GRIP_RATE = 1.4;
const HIT_RADIUS = 1.05;
const HIT_OFFSET = 1.15;
const IMPACT_MIN_SPEED = 3;
const RESTITUTION = 0.25;
const CONTACT_FRICTION = 0.92;

interface Box { minX: number; maxX: number; minZ: number; maxZ: number }

function isFiniteIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validate(raw: unknown, playerId: string): { ok: true; input: InputCommand } | { ok: false; result: InputResult } {
  const reject = (reason: "bad-shape" | "bad-version" | "out-of-range" | "unknown-player") => ({ ok: false as const, result: { accepted: false as const, reason } });
  if (typeof raw !== "object" || raw === null) return reject("bad-shape");
  const c = raw as Record<string, unknown>;
  if (c.v !== CONTRACT_VERSION) return reject(c.v === undefined ? "bad-shape" : "bad-version");
  if (typeof c.playerId !== "string" || typeof c.brake !== "boolean" || typeof c.tick !== "number") return reject("bad-shape");
  if (c.playerId !== playerId) return reject("unknown-player");
  if (!isFiniteIn(c.steer, -1, 1) || !isFiniteIn(c.throttle, -1, 1) || !Number.isInteger(c.tick) || c.tick < 0) return reject("out-of-range");
  return { ok: true, input: { v: CONTRACT_VERSION, tick: c.tick, playerId, steer: c.steer, throttle: c.throttle, brake: c.brake } };
}

/** The car's two collision circles (front and rear), so the nose and tail cannot clip a wall. */
export function hitCircles(x: number, z: number, heading: number): [Vec2, Vec2] {
  const fx = Math.sin(heading) * HIT_OFFSET;
  const fz = Math.cos(heading) * HIT_OFFSET;
  return [[x + fx, z + fz], [x - fx, z - fz]];
}
export const CAR_HIT_RADIUS = HIT_RADIUS;

/** Create the local-authority city world: one car, fixed ticks, footprint collision. */
export function createCityWorld(city: CityData, options: CityWorldOptions): CityAuthority {
  const playerId = options.playerId ?? "player-1";
  const kind: VehicleKind = options.vehicle ?? "switchback";
  const spec = VEHICLE_SPECS[kind];
  const maxSpeed = spec.maxSpeed * CITY_SPEED_SCALE;
  const acceleration = spec.acceleration * CITY_ACCEL_SCALE;
  const { bounds } = city;

  const geometry = createIndexedGeometry(city);
  const boxes: Box[] = city.buildings.map((b) => {
    const xs = b.footprint.map((p) => p[0]);
    const zs = b.footprint.map((p) => p[1]);
    return { minX: Math.min(...xs) - HIT_RADIUS, maxX: Math.max(...xs) + HIT_RADIUS, minZ: Math.min(...zs) - HIT_RADIUS, maxZ: Math.max(...zs) + HIT_RADIUS };
  });

  const layout: ArenaLayout = {
    halfExtent: Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX), Math.abs(bounds.minZ), Math.abs(bounds.maxZ)),
    obstacles: city.buildings.map((b, i) => {
      const box = boxes[i]!;
      return { x: (box.minX + box.maxX) / 2, z: (box.minZ + box.maxZ) / 2, halfX: (box.maxX - box.minX) / 2 - HIT_RADIUS, halfZ: (box.maxZ - box.minZ) / 2 - HIT_RADIUS };
    }),
  };

  let x = 0;
  let z = 0;
  let heading = 0;
  let vx = 0;
  let vz = 0;
  let forward = 0;
  let lateral = 0;
  let offRoad = false;
  let input: InputCommand = { v: CONTRACT_VERSION, tick: 0, playerId, steer: 0, throttle: 0, brake: false };
  let tick = 0;
  let accumulator = 0;
  let impactedLastTick = false;
  let disposed = false;
  let events: SimEvent[] = [];

  function place(spawnIndex: number): void {
    const spawn = city.spawns[spawnIndex] ?? city.spawns[0] ?? { x: 0, z: 0, heading: 0 };
    x = spawn.x; z = spawn.z; heading = spawn.heading;
    vx = 0; vz = 0; forward = 0; lateral = 0; offRoad = false;
    impactedLastTick = false;
    input = { ...input, steer: 0, throttle: 0, brake: false };
    events.push({ v: CONTRACT_VERSION, tick, kind: "spawned", playerId });
  }
  place(options.spawnIndex ?? 0);

  function step(): void {
    tick += 1;
    const dt = TICK_SECONDS;
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const rx = fz;
    const rz = -fx;
    forward = vx * fx + vz * fz;
    lateral = vx * rx + vz * rz;

    forward += input.throttle * acceleration * dt;
    if (input.brake) {
      const slowed = BRAKE_DECELERATION * dt;
      forward = Math.abs(forward) <= slowed ? 0 : forward - Math.sign(forward) * slowed;
    }
    forward -= forward * (DRAG + (offRoad ? OFFROAD_DRAG : 0)) * dt;
    const cap = maxSpeed * (offRoad ? OFFROAD_SPEED_KEPT : 1);
    forward = Math.max(-maxSpeed * 0.4, Math.min(cap, forward));

    // Steering turns the nose; the velocity then lags it, which is the slide. The handbrake loosens grip.
    const authority = Math.max(-1, Math.min(1, forward / (maxSpeed * 0.25)));
    heading -= input.steer * spec.turnRate * authority * dt;
    lateral *= Math.exp(-(input.brake ? DRIFT_GRIP_RATE : GRIP_RATE) * dt);

    const nfx = Math.sin(heading);
    const nfz = Math.cos(heading);
    vx = nfx * forward + nfz * lateral;
    vz = nfz * forward - nfx * lateral;
    x += vx * dt;
    z += vz * dt;

    let hit = false;
    let impactSpeed = 0;
    for (let pass = 0; pass < 3; pass += 1) {
      let moved = false;
      for (const [cx, cz] of hitCircles(x, z, heading)) {
        for (const contact of geometry.contacts(cx, cz, HIT_RADIUS)) {
          x += contact.nx * contact.depth;
          z += contact.nz * contact.depth;
          const vn = vx * contact.nx + vz * contact.nz;
          if (vn < 0) {
            vx -= (1 + RESTITUTION) * vn * contact.nx;
            vz -= (1 + RESTITUTION) * vn * contact.nz;
            impactSpeed = Math.max(impactSpeed, -vn);
          }
          vx *= CONTACT_FRICTION; vz *= CONTACT_FRICTION;
          moved = true; hit = true;
        }
      }
      if (!moved) break;
    }

    // The district edge is a wall too.
    const m = HIT_OFFSET + HIT_RADIUS;
    if (x < bounds.minX + m) { x = bounds.minX + m; vx = Math.max(0, vx); hit = true; }
    if (x > bounds.maxX - m) { x = bounds.maxX - m; vx = Math.min(0, vx); hit = true; }
    if (z < bounds.minZ + m) { z = bounds.minZ + m; vz = Math.max(0, vz); hit = true; }
    if (z > bounds.maxZ - m) { z = bounds.maxZ - m; vz = Math.min(0, vz); hit = true; }

    if (hit && !impactedLastTick && impactSpeed >= IMPACT_MIN_SPEED) {
      events.push({ v: CONTRACT_VERSION, tick, kind: "impact", playerId, speed: impactSpeed });
    }
    impactedLastTick = hit;
    const ufx = Math.sin(heading);
    const ufz = Math.cos(heading);
    forward = vx * ufx + vz * ufz;
    lateral = vx * ufz - vz * ufx;
    offRoad = !geometry.onRoad(x, z);
  }

  const state = (): CityVehicleState => ({ playerId, x, z, heading, speed: forward, kind, lateral, offRoad });

  return {
    city,
    layout,
    submitInput(raw) {
      const checked = validate(raw, playerId);
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
      } else accumulator = Math.max(0, accumulator - steps * TICK_SECONDS);
      for (let i = 0; i < steps; i += 1) step();
      return steps;
    },
    snapshot(): CitySnapshot {
      return { v: CONTRACT_VERSION, tick, seed: options.seed, vehicles: [state()] };
    },
    drainEvents() {
      const drained = events;
      events = [];
      return drained;
    },
    reset(spawnIndex = 0) {
      place(spawnIndex);
    },
    dispose() {
      disposed = true;
    },
  };
}
