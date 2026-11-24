import { ARENA, SPAWNS, VEHICLE_KINDS, VEHICLE_SPECS, rayCover, type Spawn } from "./arena";
import { createBotBrain, createStreetNav, type BotBrain, type BotCommand, type BotNav } from "./bots";
import {
  CONTRACT_VERSION,
  MAX_STEPS_PER_ADVANCE,
  TICK_RATE,
  TICK_SECONDS,
  type CombatAuthority,
  type CombatArenaLayout,
  type CombatSnapshot,
  type CombatVehicleState,
  type InputCommand,
  type InputRejection,
  type InputResult,
  type MatchReason,
  type MatchStatus,
  type MissileState,
  type PickupKind,
  type PickupPad,
  type PickupState,
  type SimEvent,
  type VehicleKind,
  type WeaponKind,
} from "./contracts";
import { CITY_ACCEL_SCALE, CITY_SPEED_SCALE, CAR_HIT_RADIUS, hitCircles } from "../maps/midtown";
import type { Bounds, CityData } from "../maps/city-compiler";
import { createCityGeometry, createRng, resolveBox, type CityGeometry } from "./world";

export const MATCH_SECONDS = 300;
export const MATCH_TICKS = MATCH_SECONDS * TICK_RATE;
export const PLAYER_ID = "player-1";
export const MAX_BOTS = 4;

export const GUN_DAMAGE = 4;
export const GUN_COOLDOWN_TICKS = 7;
export const GUN_RANGE = 32;
export const MISSILE_DAMAGE = 30;
export const MISSILE_COOLDOWN_TICKS = 40;
export const MISSILE_START_AMMO = 4;
export const MISSILE_MAX_AMMO = 8;
export const HEALTH_PICKUP = 40;
export const AMMO_PICKUP = 3;
export const PICKUP_RESPAWN_TICKS = 15 * TICK_RATE;
export const SPECIAL_COOLDOWN_TICKS = 20 * TICK_RATE;

const VEHICLE_RADIUS = 1.2;
const HIT_RADIUS = 1.35;
const PAD_RADIUS = 2.5;
const SPLASH_RADIUS = 4;
const MISSILE_SPEED = 38;
const MISSILE_TURN = 2.6;
const MISSILE_LIFE_TICKS = 150;
const LOCK_RANGE = 55;
const LOCK_CONE = 0.4;
const LOCK_KEEP_CONE = 0.7;
/** Bots hit softer than the player so four of them are a threat, not an instant loss. */
export const BOT_DAMAGE_SCALE = 0.45;
const PLAYER_SPREAD = 0.02;
const BOT_SPREAD = 0.045;
const DRAG = 0.6;
const BRAKE_DECELERATION = 26;
const WALL_SPEED_KEPT = 0.35;
const IMPACT_MIN_SPEED = 3;
const RAMP_MIN_SPEED = 6;
const RAMP_AIR_TICKS = 40;
const BOOST_TICKS = 90;
const SHOCKWAVE_RADIUS = 10;
const SHOCKWAVE_DAMAGE = 22;
const REPAIR_AMOUNT = 35;
const EVENT_CAP = 1024;

export interface CombatOptions {
  seed: number;
  /** The vehicle the player drives. */
  playerVehicle?: VehicleKind;
  /** Number of bot opponents, 0 to 4. Defaults to 4. */
  bots?: number;
}

interface Rocket extends MissileState {
  age: number;
}

interface Car extends CombatVehicleState {
  /** Velocity in the city model, where a car slides; unused in the flat arena. */
  vx: number;
  vz: number;
  offRoad: boolean;
  gunCooldown: number;
  missileCooldown: number;
  prevMissile: boolean;
  prevSpecial: boolean;
  impacted: boolean;
}

/* ---------------------------------------------------------------- where a match is fought */

/** A pickup pad is this wide in a city, where a car crosses a junction in a blink. */
export const CITY_PAD_RADIUS = 4;
const CITY_PICKUPS = 4;
const CITY_BOT_POOL = 6;
const CITY_BOT_MIN_GAP = 60;
const CITY_DRAG = 0.35;
const CITY_OFFROAD_DRAG = 1.6;
const CITY_OFFROAD_SPEED_KEPT = 0.6;
const CITY_BRAKE_DECELERATION = 38;
const GRIP_RATE = 7;
const DRIFT_GRIP_RATE = 1.4;
const HIT_OFFSET = 1.15;
const RESTITUTION = 0.25;
const CONTACT_FRICTION = 0.92;

interface CityPlace { geometry: CityGeometry; bounds: Bounds }

/** Everything that differs between the flat arena and a city: walls, spawns, pads and bot sight. */
interface Place {
  layout: CombatArenaLayout;
  padRadius: number;
  /** Start positions: the player's first, then one per bot. Draws from the match generator. */
  spawns(rng: () => number, botCount: number): Spawn[];
  /** Distance along a unit ray to the first wall, Infinity when open. */
  cover(ox: number, oz: number, dx: number, dz: number): number;
  /** True where a missile bursts on solid ground. */
  solid(x: number, z: number): boolean;
  /** Push a shoved car back out of walls. */
  settle(car: { x: number; z: number }): void;
  nav?: BotNav;
  city?: CityPlace;
}

function arenaPlace(): Place {
  const layout = ARENA;
  return {
    layout,
    padRadius: PAD_RADIUS,
    spawns(rng) {
      // The seed decides which spawn each bot takes.
      const slots = [1, 2, 3, 4];
      for (let i = slots.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [slots[i], slots[j]] = [slots[j]!, slots[i]!];
      }
      return [SPAWNS[0]!, ...slots.map((slot) => SPAWNS[slot]!)];
    },
    cover: (ox, oz, dx, dz) => rayCover(layout, ox, oz, dx, dz),
    solid: (x, z) =>
      Math.abs(x) >= layout.halfExtent ||
      Math.abs(z) >= layout.halfExtent ||
      layout.obstacles.some((o) => Math.abs(x - o.x) <= o.halfX && Math.abs(z - o.z) <= o.halfZ),
    settle(car) {
      for (const box of layout.obstacles) resolveBox(car, box, VEHICLE_RADIUS);
      car.x = Math.max(-layout.halfExtent + VEHICLE_RADIUS, Math.min(layout.halfExtent - VEHICLE_RADIUS, car.x));
      car.z = Math.max(-layout.halfExtent + VEHICLE_RADIUS, Math.min(layout.halfExtent - VEHICLE_RADIUS, car.z));
    },
  };
}

/** Pickups sit on street junctions, spread across the district: the busiest crossing first. */
function cityPads(city: CityData): PickupPad[] {
  const neighbours = new Map<number, Set<number>>();
  for (const e of city.graph.edges) {
    for (const [a, b] of [[e.from, e.to], [e.to, e.from]] as const) neighbours.set(a, (neighbours.get(a) ?? new Set<number>()).add(b));
  }
  const nodes = city.graph.nodes.map((node, index) => ({ node, index, degree: neighbours.get(index)?.size ?? 0 }));
  let pool = nodes.filter((n) => n.degree >= 3);
  if (pool.length < CITY_PICKUPS) pool = nodes.filter((n) => n.degree >= 2);
  pool = pool.sort((a, b) => Math.hypot(a.node.x, a.node.z) - Math.hypot(b.node.x, b.node.z) || a.index - b.index);
  const chosen: typeof pool = [];
  while (chosen.length < Math.min(CITY_PICKUPS, pool.length)) {
    let best = pool[0]!;
    let bestGap = -1;
    for (const candidate of pool) {
      if (chosen.includes(candidate)) continue;
      const gap = chosen.length === 0 ? 0 : Math.min(...chosen.map((c) => Math.hypot(c.node.x - candidate.node.x, c.node.z - candidate.node.z)));
      if (chosen.length === 0 || gap > bestGap) { best = candidate; bestGap = gap; }
      if (chosen.length === 0) break;
    }
    chosen.push(best);
  }
  return chosen.map((c, k): PickupPad => {
    const kind: PickupKind = k % 2 === 0 ? "health" : "ammo";
    return { id: `${kind}-${c.index}`, kind, x: c.node.x, z: c.node.z };
  });
}

function cityPlace(city: CityData): Place {
  const geometry = createCityGeometry(city);
  const { bounds } = city;
  const layout: CombatArenaLayout = {
    halfExtent: Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX), Math.abs(bounds.minZ), Math.abs(bounds.maxZ)),
    obstacles: city.buildings.map((b) => {
      const xs = b.footprint.map((p) => p[0]);
      const zs = b.footprint.map((p) => p[1]);
      const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
      return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, halfX: (maxX - minX) / 2, halfZ: (maxZ - minZ) / 2 };
    }),
    ramps: [],
    pads: cityPads(city),
  };
  const margin = HIT_OFFSET + CAR_HIT_RADIUS;
  const inside = (x: number, z: number): boolean => x > bounds.minX && x < bounds.maxX && z > bounds.minZ && z < bounds.maxZ;
  return {
    layout,
    padRadius: CITY_PAD_RADIUS,
    spawns(rng, botCount) {
      const pool: Spawn[] = city.spawns.length > 0 ? city.spawns : [{ x: 0, z: 0, heading: 0 }];
      const player = pool[0]!;
      // Bots start on streets near the player, but not on top of them: a fight within seconds, not at once.
      const gap = (s: Spawn): number => Math.hypot(s.x - player.x, s.z - player.z);
      const all = pool.slice(1).sort((a, b) => gap(a) - gap(b));
      const apart = all.filter((s) => gap(s) >= CITY_BOT_MIN_GAP);
      const others = apart.length >= botCount ? apart : all;
      const near = others.slice(0, Math.max(botCount, Math.min(CITY_BOT_POOL, others.length)));
      for (let i = near.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [near[i], near[j]] = [near[j]!, near[i]!];
      }
      return [player, ...Array.from({ length: botCount }, (_, i) => near[i] ?? pool[(i + 1) % pool.length]!)];
    },
    cover: geometry.rayCover,
    solid: (x, z) => !inside(x, z) || geometry.solidAt(x, z),
    settle(car) {
      for (let pass = 0; pass < 3; pass += 1) {
        const contacts = geometry.contacts(car.x, car.z, VEHICLE_RADIUS);
        for (const c of contacts) { car.x += c.nx * c.depth; car.z += c.nz * c.depth; }
        if (contacts.length === 0) break;
      }
      car.x = Math.max(bounds.minX + margin, Math.min(bounds.maxX - margin, car.x));
      car.z = Math.max(bounds.minZ + margin, Math.min(bounds.maxZ - margin, car.z));
    },
    nav: createStreetNav(city, geometry),
    city: { geometry, bounds },
  };
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isFiniteIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validate(raw: unknown): { ok: true; input: InputCommand } | { ok: false; reason: InputRejection } {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "bad-shape" };
  const c = raw as Record<string, unknown>;
  if (c.v !== CONTRACT_VERSION) return { ok: false, reason: c.v === undefined ? "bad-shape" : "bad-version" };
  if (typeof c.playerId !== "string" || typeof c.brake !== "boolean" || typeof c.tick !== "number") return { ok: false, reason: "bad-shape" };
  if (![c.fire, c.missile, c.special].every(isOptionalBoolean)) return { ok: false, reason: "bad-shape" };
  if (c.playerId !== PLAYER_ID) return { ok: false, reason: "unknown-player" };
  if (!isFiniteIn(c.steer, -1, 1) || !isFiniteIn(c.throttle, -1, 1) || !Number.isInteger(c.tick) || c.tick < 0) return { ok: false, reason: "out-of-range" };
  return {
    ok: true,
    input: {
      v: CONTRACT_VERSION,
      tick: c.tick,
      playerId: PLAYER_ID,
      steer: c.steer,
      throttle: c.throttle,
      brake: c.brake,
      fire: c.fire === true,
      missile: c.missile === true,
      special: c.special === true,
    },
  };
}

/**
 * Create one deterministic, seeded combat match in the original arena. Pure TypeScript with no
 * React, DOM or timers, so a test, a render loop or a later server tick produce identical results.
 */
export function createCombatMatch(options: CombatOptions): CombatAuthority {
  return createMatch(arenaPlace(), options);
}

/**
 * Create one deterministic, seeded combat match in a compiled city: the player and the bots start on
 * road spawns, drive with footprint collision, and buildings block shots, locks and missiles. The
 * weapons, ammo, pickups, five-minute limit and win and loss rules are the arena's, unchanged.
 */
export function createCityMatch(city: CityData, options: CombatOptions): CombatAuthority {
  return createMatch(cityPlace(city), options);
}

function createMatch(place: Place, options: CombatOptions): CombatAuthority {
  const { seed } = options;
  const playerKind = options.playerVehicle ?? "switchback";
  const botCount = Math.max(0, Math.min(MAX_BOTS, Math.floor(options.bots ?? MAX_BOTS)));
  const layout = place.layout;

  let rng = createRng(seed);
  let cars: Car[] = [];
  let brains: (BotBrain | null)[] = [];
  let pickups: PickupState[] = [];
  let missiles: Rocket[] = [];
  let nextMissileId = 1;
  let input: InputCommand;
  let tick = 0;
  let accumulator = 0;
  let disposed = false;
  let status: MatchStatus = "running";
  let reason: MatchReason | null = null;
  let endedTick: number | null = null;
  let events: SimEvent[] = [];

  function emit(event: SimEvent): void {
    events.push(event);
    if (events.length > EVENT_CAP) events.splice(0, events.length - EVENT_CAP);
  }

  function makeCar(playerId: string, kind: VehicleKind, bot: boolean, spawn: Spawn): Car {
    const spec = VEHICLE_SPECS[kind];
    return {
      playerId, x: spawn.x, z: spawn.z, heading: spawn.heading, speed: 0, vx: 0, vz: 0, offRoad: false,
      kind, bot, health: spec.maxHealth, maxHealth: spec.maxHealth, alive: true,
      missiles: MISSILE_START_AMMO, maxMissiles: MISSILE_MAX_AMMO,
      special: spec.special, specialCooldown: 0, lockId: null,
      lastHitTick: -1000, wreckedTick: null, airborne: 0, boost: 0,
      gunCooldown: 0, missileCooldown: 0, prevMissile: false, prevSpecial: false, impacted: false,
    };
  }

  function reset(): void {
    rng = createRng(seed);
    tick = 0;
    accumulator = 0;
    status = "running";
    reason = null;
    endedTick = null;
    nextMissileId = 1;
    missiles = [];
    events = [];
    input = { v: CONTRACT_VERSION, tick: 0, playerId: PLAYER_ID, steer: 0, throttle: 0, brake: false, fire: false, missile: false, special: false };
    // The seed decides which spawn each bot takes and which vehicle it drives.
    const starts = place.spawns(rng, botCount);
    cars = [makeCar(PLAYER_ID, playerKind, false, starts[0]!)];
    brains = [null];
    for (let i = 0; i < botCount; i += 1) {
      const kind = VEHICLE_KINDS[Math.floor(rng() * VEHICLE_KINDS.length)]!;
      cars.push(makeCar(`bot-${i + 1}`, kind, true, starts[i + 1]!));
      brains.push(createBotBrain(seed + 7919 * (i + 1)));
    }
    pickups = layout.pads.map((pad) => ({ ...pad, ready: true, respawnTicks: 0 }));
    emit({ v: CONTRACT_VERSION, tick: 0, kind: "spawned", playerId: PLAYER_ID });
    for (const car of cars) if (car.bot) emit({ v: CONTRACT_VERSION, tick: 0, kind: "spawned", playerId: car.playerId });
  }

  function carById(id: string | null): Car | undefined {
    return id === null ? undefined : cars.find((c) => c.playerId === id);
  }

  function damage(target: Car, amount: number, sourceId: string | null, weapon: WeaponKind, x: number, z: number): void {
    if (!target.alive || amount <= 0) return;
    const dealt = Math.min(target.health, amount);
    target.health -= dealt;
    target.lastHitTick = tick;
    emit({ v: CONTRACT_VERSION, tick, kind: "hit", playerId: sourceId ?? "arena", targetId: target.playerId, weapon, damage: dealt, x, z });
    if (target.health <= 0) {
      target.health = 0;
      target.alive = false;
      target.speed = 0;
      target.lockId = null;
      target.wreckedTick = tick;
      emit({ v: CONTRACT_VERSION, tick, kind: "wrecked", playerId: target.playerId, byId: sourceId, x: target.x, z: target.z });
    }
  }

  function commandFor(car: Car, index: number): BotCommand {
    if (!car.bot) {
      return { steer: input.steer, throttle: input.throttle, brake: input.brake, fire: input.fire === true, missile: input.missile === true, special: input.special === true };
    }
    return brains[index]!.think({ self: car, vehicles: cars, pickups, layout, tick, nav: place.nav });
  }

  /** A city car slides: steering turns the nose, the velocity lags it, and buildings are solid. */
  function driveCity(car: Car, command: BotCommand, ground: CityPlace): void {
    const spec = VEHICLE_SPECS[car.kind];
    const boosting = car.boost > 0;
    const maxSpeed = spec.maxSpeed * CITY_SPEED_SCALE * (boosting ? 1.6 : 1);
    const acceleration = spec.acceleration * CITY_ACCEL_SCALE * (boosting ? 2 : 1);
    const dt = TICK_SECONDS;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    let forward = car.vx * fx + car.vz * fz;
    let lateral = car.vx * fz - car.vz * fx;
    forward += command.throttle * acceleration * dt;
    if (command.brake) {
      const slowed = CITY_BRAKE_DECELERATION * dt;
      forward = Math.abs(forward) <= slowed ? 0 : forward - Math.sign(forward) * slowed;
    }
    forward -= forward * (CITY_DRAG + (car.offRoad ? CITY_OFFROAD_DRAG : 0)) * dt;
    forward = Math.max(-maxSpeed * 0.4, Math.min(maxSpeed * (car.offRoad ? CITY_OFFROAD_SPEED_KEPT : 1), forward));
    const authority = Math.max(-1, Math.min(1, forward / (maxSpeed * 0.25)));
    car.heading -= command.steer * spec.turnRate * authority * dt;
    lateral *= Math.exp(-(command.brake ? DRIFT_GRIP_RATE : GRIP_RATE) * dt);
    const nfx = Math.sin(car.heading);
    const nfz = Math.cos(car.heading);
    car.vx = nfx * forward + nfz * lateral;
    car.vz = nfz * forward - nfx * lateral;
    car.x += car.vx * dt;
    car.z += car.vz * dt;

    let hit = false;
    let impactSpeed = 0;
    for (let pass = 0; pass < 3; pass += 1) {
      let moved = false;
      for (const [cx, cz] of hitCircles(car.x, car.z, car.heading)) {
        for (const contact of ground.geometry.contacts(cx, cz, CAR_HIT_RADIUS)) {
          car.x += contact.nx * contact.depth;
          car.z += contact.nz * contact.depth;
          const vn = car.vx * contact.nx + car.vz * contact.nz;
          if (vn < 0) {
            car.vx -= (1 + RESTITUTION) * vn * contact.nx;
            car.vz -= (1 + RESTITUTION) * vn * contact.nz;
            impactSpeed = Math.max(impactSpeed, -vn);
          }
          car.vx *= CONTACT_FRICTION;
          car.vz *= CONTACT_FRICTION;
          moved = true;
          hit = true;
        }
      }
      if (!moved) break;
    }
    // The district edge is a wall too.
    const { bounds } = ground;
    const m = HIT_OFFSET + CAR_HIT_RADIUS;
    if (car.x < bounds.minX + m) { car.x = bounds.minX + m; car.vx = Math.max(0, car.vx); hit = true; }
    if (car.x > bounds.maxX - m) { car.x = bounds.maxX - m; car.vx = Math.min(0, car.vx); hit = true; }
    if (car.z < bounds.minZ + m) { car.z = bounds.minZ + m; car.vz = Math.max(0, car.vz); hit = true; }
    if (car.z > bounds.maxZ - m) { car.z = bounds.maxZ - m; car.vz = Math.min(0, car.vz); hit = true; }
    if (hit && !car.impacted && impactSpeed >= IMPACT_MIN_SPEED) {
      emit({ v: CONTRACT_VERSION, tick, kind: "impact", playerId: car.playerId, speed: impactSpeed });
    }
    car.impacted = hit;
    if (car.boost > 0) car.boost -= 1;
    car.speed = car.vx * Math.sin(car.heading) + car.vz * Math.cos(car.heading);
    car.offRoad = !ground.geometry.onRoad(car.x, car.z);
  }

  function drive(car: Car, command: BotCommand): void {
    if (place.city) return driveCity(car, command, place.city);
    const spec = VEHICLE_SPECS[car.kind];
    const boosting = car.boost > 0;
    const maxSpeed = spec.maxSpeed * (boosting ? 1.6 : 1) * (car.airborne > 0 ? 1.1 : 1);
    let speed = car.speed;
    speed += command.throttle * spec.acceleration * (boosting ? 2 : 1) * TICK_SECONDS;
    if (command.brake) {
      const slowed = BRAKE_DECELERATION * TICK_SECONDS;
      speed = Math.abs(speed) <= slowed ? 0 : speed - Math.sign(speed) * slowed;
    }
    speed -= speed * DRAG * TICK_SECONDS;
    speed = Math.max(-maxSpeed * 0.4, Math.min(maxSpeed, speed));
    // Airborne cars barely steer; a hard-won grip is part of the feel.
    const grip = Math.max(-1, Math.min(1, speed / (spec.maxSpeed * 0.3))) * (car.airborne > 0 ? 0.25 : 1);
    car.heading -= command.steer * spec.turnRate * grip * TICK_SECONDS;
    car.x += Math.sin(car.heading) * speed * TICK_SECONDS;
    car.z += Math.cos(car.heading) * speed * TICK_SECONDS;

    let hit = false;
    const limit = layout.halfExtent - VEHICLE_RADIUS;
    if (Math.abs(car.x) > limit) {
      car.x = Math.sign(car.x) * limit;
      hit = true;
    }
    if (Math.abs(car.z) > limit) {
      car.z = Math.sign(car.z) * limit;
      hit = true;
    }
    for (const box of layout.obstacles) hit = resolveBox(car, box, VEHICLE_RADIUS) || hit;
    if (hit) {
      if (!car.impacted && Math.abs(speed) >= IMPACT_MIN_SPEED) {
        emit({ v: CONTRACT_VERSION, tick, kind: "impact", playerId: car.playerId, speed: Math.abs(speed) });
      }
      speed *= WALL_SPEED_KEPT;
    }
    car.impacted = hit;

    if (car.airborne > 0) car.airborne -= 1;
    else if (speed >= RAMP_MIN_SPEED) {
      for (const ramp of layout.ramps) {
        if (Math.abs(car.x - ramp.x) <= ramp.halfX && Math.abs(car.z - ramp.z) <= ramp.halfZ) {
          car.airborne = RAMP_AIR_TICKS;
          speed = Math.min(spec.maxSpeed * 1.2, speed * 1.2);
          emit({ v: CONTRACT_VERSION, tick, kind: "launch", playerId: car.playerId });
          break;
        }
      }
    }
    if (car.boost > 0) car.boost -= 1;
    car.speed = speed;
  }

  function separate(): void {
    for (let i = 0; i < cars.length; i += 1) {
      for (let j = i + 1; j < cars.length; j += 1) {
        const a = cars[i];
        const b = cars[j];
        if (!a.alive || !b.alive) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const distance = Math.hypot(dx, dz);
        const minimum = VEHICLE_RADIUS * 2;
        if (distance >= minimum) continue;
        const nx = distance > 1e-6 ? dx / distance : 1;
        const nz = distance > 1e-6 ? dz / distance : 0;
        const push = (minimum - distance) / 2;
        a.x -= nx * push;
        a.z -= nz * push;
        b.x += nx * push;
        b.z += nz * push;
        a.speed *= 0.9;
        b.speed *= 0.9;
        a.vx *= 0.9; a.vz *= 0.9;
        b.vx *= 0.9; b.vz *= 0.9;
      }
    }
  }

  function updateLock(car: Car): void {
    if (!car.alive) return;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const angleTo = (other: Car): number => Math.abs(Math.atan2(fx * (other.z - car.z) - fz * (other.x - car.x), fx * (other.x - car.x) + fz * (other.z - car.z)));
    const visible = (other: Car): boolean => other.alive && other.playerId !== car.playerId && Math.hypot(other.x - car.x, other.z - car.z) <= LOCK_RANGE
      && place.cover(car.x, car.z, other.x - car.x, other.z - car.z) >= Math.hypot(other.x - car.x, other.z - car.z);
    const kept = carById(car.lockId);
    if (kept && visible(kept) && angleTo(kept) <= LOCK_KEEP_CONE) return;
    let best: Car | null = null;
    let bestDistance = Infinity;
    for (const other of cars) {
      if (!visible(other) || angleTo(other) > LOCK_CONE) continue;
      const d = Math.hypot(other.x - car.x, other.z - car.z);
      if (d < bestDistance) {
        bestDistance = d;
        best = other;
      }
    }
    car.lockId = best ? best.playerId : null;
  }

  function fireGun(car: Car): void {
    const heading = car.heading + (rng() * 2 - 1) * (car.bot ? BOT_SPREAD : PLAYER_SPREAD);
    const dx = Math.sin(heading);
    const dz = Math.cos(heading);
    const ox = car.x + dx * 1.5;
    const oz = car.z + dz * 1.5;
    const cover = place.cover(ox, oz, dx, dz);
    let reach = Math.min(GUN_RANGE, cover);
    let victim: Car | null = null;
    for (const other of cars) {
      if (!other.alive || other.playerId === car.playerId) continue;
      const rx = other.x - ox;
      const rz = other.z - oz;
      const along = rx * dx + rz * dz;
      if (along < 0 || along > reach) continue;
      if (Math.abs(rx * dz - rz * dx) > HIT_RADIUS) continue;
      reach = along;
      victim = other;
    }
    emit({ v: CONTRACT_VERSION, tick, kind: "shot", playerId: car.playerId, x: ox, z: oz, toX: ox + dx * reach, toZ: oz + dz * reach });
    if (victim) damage(victim, GUN_DAMAGE * (car.bot ? BOT_DAMAGE_SCALE : 1), car.playerId, "gun", ox + dx * reach, oz + dz * reach);
  }

  function launchMissile(car: Car): void {
    car.missiles -= 1;
    car.missileCooldown = MISSILE_COOLDOWN_TICKS;
    const targetId = car.lockId;
    missiles.push({ id: nextMissileId++, ownerId: car.playerId, x: car.x + Math.sin(car.heading) * 1.8, z: car.z + Math.cos(car.heading) * 1.8, heading: car.heading, targetId, age: 0 });
    emit({ v: CONTRACT_VERSION, tick, kind: "missile-launched", playerId: car.playerId, targetId });
  }

  function useSpecial(car: Car): void {
    car.specialCooldown = SPECIAL_COOLDOWN_TICKS;
    emit({ v: CONTRACT_VERSION, tick, kind: "special", playerId: car.playerId, special: car.special });
    if (car.special === "repair") {
      car.health = Math.min(car.maxHealth, car.health + REPAIR_AMOUNT);
    } else if (car.special === "afterburner") {
      car.boost = BOOST_TICKS;
    } else {
      for (const other of cars) {
        if (!other.alive || other.playerId === car.playerId) continue;
        const d = Math.hypot(other.x - car.x, other.z - car.z);
        if (d > SHOCKWAVE_RADIUS) continue;
        // Shove the target away from the blast; cover and walls still hold it in.
        const nx = d > 1e-6 ? (other.x - car.x) / d : 1;
        const nz = d > 1e-6 ? (other.z - car.z) / d : 0;
        other.x += nx * 2.5;
        other.z += nz * 2.5;
        place.settle(other);
        damage(other, SHOCKWAVE_DAMAGE, car.playerId, "special", other.x, other.z);
      }
    }
  }

  function explode(missile: Rocket, direct: Car | null): void {
    for (const other of cars) {
      if (!other.alive || other.playerId === missile.ownerId) continue;
      const d = Math.hypot(other.x - missile.x, other.z - missile.z);
      if (other !== direct && d > SPLASH_RADIUS) continue;
      const falloff = other === direct ? 1 : 1 - 0.6 * (d / SPLASH_RADIUS);
      const owner = carById(missile.ownerId);
      damage(other, Math.round(MISSILE_DAMAGE * falloff * (owner?.bot ? BOT_DAMAGE_SCALE : 1)), missile.ownerId, "missile", missile.x, missile.z);
    }
  }

  function stepMissiles(): void {
    const remaining: Rocket[] = [];
    for (const missile of missiles) {
      const target = carById(missile.targetId);
      if (target?.alive) {
        const desired = Math.atan2(target.x - missile.x, target.z - missile.z);
        let error = desired - missile.heading;
        while (error > Math.PI) error -= Math.PI * 2;
        while (error < -Math.PI) error += Math.PI * 2;
        const maxTurn = MISSILE_TURN * TICK_SECONDS;
        missile.heading += Math.max(-maxTurn, Math.min(maxTurn, error));
      }
      missile.x += Math.sin(missile.heading) * MISSILE_SPEED * TICK_SECONDS;
      missile.z += Math.cos(missile.heading) * MISSILE_SPEED * TICK_SECONDS;
      missile.age += 1;

      let direct: Car | null = null;
      for (const other of cars) {
        if (other.alive && other.playerId !== missile.ownerId && Math.hypot(other.x - missile.x, other.z - missile.z) < HIT_RADIUS + 0.4) {
          direct = other;
          break;
        }
      }
      const blocked = place.solid(missile.x, missile.z);
      if (direct || blocked || missile.age >= MISSILE_LIFE_TICKS) explode(missile, direct);
      else remaining.push(missile);
    }
    missiles = remaining;
  }

  function stepPickups(): void {
    for (const pad of pickups) {
      if (!pad.ready) {
        pad.respawnTicks -= 1;
        if (pad.respawnTicks <= 0) {
          pad.ready = true;
          pad.respawnTicks = 0;
          emit({ v: CONTRACT_VERSION, tick, kind: "pickup-ready", padId: pad.id });
        }
        continue;
      }
      for (const car of cars) {
        if (!car.alive || Math.hypot(car.x - pad.x, car.z - pad.z) > place.padRadius) continue;
        if (pad.kind === "health" ? car.health >= car.maxHealth : car.missiles >= car.maxMissiles) continue;
        if (pad.kind === "health") car.health = Math.min(car.maxHealth, car.health + HEALTH_PICKUP);
        else car.missiles = Math.min(car.maxMissiles, car.missiles + AMMO_PICKUP);
        pad.ready = false;
        pad.respawnTicks = PICKUP_RESPAWN_TICKS;
        emit({ v: CONTRACT_VERSION, tick, kind: "pickup", playerId: car.playerId, padId: pad.id, pickup: pad.kind });
        break;
      }
    }
  }

  function finish(next: MatchStatus, why: MatchReason): void {
    status = next;
    reason = why;
    endedTick = tick;
    missiles = [];
    emit({ v: CONTRACT_VERSION, tick, kind: "match-ended", status: next, reason: why });
  }

  function checkEnd(): void {
    const player = cars[0];
    const bots = cars.filter((c) => c.bot);
    if (!player.alive) return finish("lost", "wrecked");
    if (bots.every((b) => !b.alive)) return finish("won", "last-car-running");
    if (tick >= MATCH_TICKS) {
      // Time is up: the player wins only by being the healthiest car still running.
      const strongest = Math.max(...bots.filter((b) => b.alive).map((b) => b.health / b.maxHealth));
      return player.health / player.maxHealth > strongest ? finish("won", "time-limit") : finish("lost", "time-limit");
    }
  }

  function step(): void {
    tick += 1;
    if (status !== "running") return;
    const commands = cars.map((car, index) => (car.alive ? commandFor(car, index) : null));
    cars.forEach((car, index) => {
      const command = commands[index];
      if (command) drive(car, command);
    });
    separate();
    for (const car of cars) updateLock(car);
    cars.forEach((car, index) => {
      const command = commands[index];
      if (!car.alive || !command) return;
      if (car.gunCooldown > 0) car.gunCooldown -= 1;
      if (car.missileCooldown > 0) car.missileCooldown -= 1;
      if (car.specialCooldown > 0) car.specialCooldown -= 1;
      if (command.fire && car.gunCooldown === 0) {
        car.gunCooldown = GUN_COOLDOWN_TICKS;
        fireGun(car);
      }
      if (command.missile && !car.prevMissile && car.missiles > 0 && car.missileCooldown === 0) launchMissile(car);
      if (command.special && !car.prevSpecial && car.specialCooldown === 0) useSpecial(car);
      car.prevMissile = command.missile;
      car.prevSpecial = command.special;
    });
    stepMissiles();
    stepPickups();
    checkEnd();
  }

  reset();

  return {
    layout,
    submitInput(raw): InputResult {
      const checked = validate(raw);
      if (!checked.ok) return { accepted: false, reason: checked.reason };
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
    snapshot(): CombatSnapshot {
      return {
        v: CONTRACT_VERSION,
        tick,
        seed,
        vehicles: cars.map((car) => ({
          playerId: car.playerId, x: car.x, z: car.z, heading: car.heading, speed: car.speed,
          kind: car.kind, bot: car.bot, health: car.health, maxHealth: car.maxHealth, alive: car.alive,
          missiles: car.missiles, maxMissiles: car.maxMissiles, special: car.special, specialCooldown: car.specialCooldown,
          lockId: car.lockId, lastHitTick: car.lastHitTick, wreckedTick: car.wreckedTick, airborne: car.airborne, boost: car.boost,
        })),
        missiles: missiles.map((m) => ({ id: m.id, ownerId: m.ownerId, x: m.x, z: m.z, heading: m.heading, targetId: m.targetId })),
        pickups: pickups.map((p) => ({ ...p })),
        match: { status, reason, endedTick, timeLimitTicks: MATCH_TICKS, botsAlive: cars.filter((c) => c.bot && c.alive).length },
      };
    },
    drainEvents() {
      const drained = events;
      events = [];
      return drained;
    },
    restart() {
      if (!disposed) reset();
    },
    dispose() {
      disposed = true;
    },
  };
}
