import { lineClear } from "./arena";
import type { CombatArenaLayout, CombatVehicleState, PickupState } from "./contracts";
import type { CityData } from "../maps/city-compiler";
import { createRng, type CityGeometry } from "./world";

/** What a bot needs to know about a city: where the streets lead and what a building hides. */
export interface BotNav {
  /** No building wall lies on the straight line between two points. */
  clear(ax: number, az: number, bx: number, bz: number): boolean;
  /** A point inside the district and at least `margin` metres from every building. */
  open(x: number, z: number, margin: number): boolean;
  /**
   * The next point to steer for when travelling by street from one place to another, or null with no
   * route. Given the car's heading, a junction behind it costs a U-turn's worth of extra distance.
   */
  waypoint(x: number, z: number, gx: number, gz: number, heading?: number): { x: number; z: number } | null;
  /** A street spot near (x, z) that a threat at (tx, tz) cannot see, or null when there is none. */
  coverSpot(x: number, z: number, tx: number, tz: number): { x: number; z: number } | null;
}

export interface BotView {
  self: CombatVehicleState;
  vehicles: readonly CombatVehicleState[];
  pickups: readonly PickupState[];
  layout: CombatArenaLayout;
  tick: number;
  /** Present in a city match: bots then route by street and see buildings as cover. */
  nav?: BotNav;
}

export interface BotCommand {
  steer: number;
  throttle: number;
  brake: boolean;
  fire: boolean;
  missile: boolean;
  special: boolean;
}

export interface BotBrain {
  think(view: BotView): BotCommand;
}

/** Bots close in for this long before they open fire, so a new match starts with a beat to react. */
export const BOT_GRACE_TICKS = 240;
const GUN_RANGE = 30;
const GUN_ALIGNMENT = 0.14;
const LOW_HEALTH = 0.4;
const COVER_TICKS = 150;
const COVER_COOLDOWN_TICKS = 600;
const STUCK_TICKS = 30;
const REVERSE_TICKS = 40;

function wrap(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** A waypoint counts as reached inside this distance, so a bot turns the corner instead of circling it. */
const REACH_M = 11;
const COVER_SEARCH_M = 140;
/** Extra road distance charged for a first junction that lies behind the car. */
const U_TURN_M = 60;
const INF = Number.POSITIVE_INFINITY;

/**
 * Street routing for a city match. Streets are treated as two-way (a wreck-fest ignores one-way
 * signs), all-pairs shortest paths are precomputed once, and a trip is snapped onto the nearest
 * street segment at both ends, so asking for the next waypoint is a handful of lookups.
 */
export function createStreetNav(city: CityData, geometry: CityGeometry): BotNav {
  const nodes = city.graph.nodes;
  const count = nodes.length;
  const dist: number[][] = Array.from({ length: count }, (_, i) => Array.from({ length: count }, (_, j) => (i === j ? 0 : INF)));
  const next: number[][] = Array.from({ length: count }, () => Array.from({ length: count }, () => -1));
  const seen = new Set<string>();
  const segments: { a: number; b: number }[] = [];
  for (const e of city.graph.edges) {
    const key = e.from < e.to ? `${e.from}-${e.to}` : `${e.to}-${e.from}`;
    if (e.from === e.to || seen.has(key)) continue;
    seen.add(key);
    segments.push({ a: e.from, b: e.to });
    dist[e.from]![e.to] = e.length;
    dist[e.to]![e.from] = e.length;
    next[e.from]![e.to] = e.to;
    next[e.to]![e.from] = e.from;
  }
  for (let k = 0; k < count; k += 1) {
    for (let i = 0; i < count; i += 1) {
      for (let j = 0; j < count; j += 1) {
        if (dist[i]![k]! + dist[k]![j]! < dist[i]![j]!) {
          dist[i]![j] = dist[i]![k]! + dist[k]![j]!;
          next[i]![j] = next[i]![k]!;
        }
      }
    }
  }

  const snap = (x: number, z: number): { seg: number; x: number; z: number } => {
    let best = { seg: -1, x, z };
    let bestD = INF;
    segments.forEach((s, i) => {
      const a = nodes[s.a]!;
      const b = nodes[s.b]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      const t = len2 === 0 ? 0 : clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1);
      const px = a.x + dx * t;
      const pz = a.z + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < bestD) { bestD = d; best = { seg: i, x: px, z: pz }; }
    });
    return best;
  };

  const route = (x: number, z: number, gx: number, gz: number, heading?: number): { x: number; z: number }[] | null => {
    const from = snap(x, z);
    const to = snap(gx, gz);
    if (from.seg < 0 || to.seg < 0) return null;
    if (from.seg === to.seg) return [{ x: to.x, z: to.z }];
    let bestCost = INF;
    let bestS = -1;
    let bestE = -1;
    for (const s of [segments[from.seg]!.a, segments[from.seg]!.b]) {
      for (const e of [segments[to.seg]!.a, segments[to.seg]!.b]) {
        const behind = heading !== undefined && (nodes[s]!.x - x) * Math.sin(heading) + (nodes[s]!.z - z) * Math.cos(heading) < 0;
        const cost = Math.hypot(nodes[s]!.x - from.x, nodes[s]!.z - from.z) + dist[s]![e]! + Math.hypot(nodes[e]!.x - to.x, nodes[e]!.z - to.z) + (behind ? U_TURN_M : 0);
        if (cost < bestCost) { bestCost = cost; bestS = s; bestE = e; }
      }
    }
    if (bestS < 0) return null;
    const path = [{ x: nodes[bestS]!.x, z: nodes[bestS]!.z }];
    for (let at = bestS; at !== bestE;) {
      at = next[at]![bestE]!;
      path.push({ x: nodes[at]!.x, z: nodes[at]!.z });
    }
    path.push({ x: to.x, z: to.z });
    return path;
  };

  const { bounds } = city;
  const spots: { x: number; z: number }[] = [...nodes.map((n) => ({ x: n.x, z: n.z }))];
  for (const s of segments) {
    const a = nodes[s.a]!;
    const b = nodes[s.b]!;
    for (const t of [0.25, 0.5, 0.75]) spots.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  }

  return {
    clear: geometry.clear,
    open: (x, z, margin) => x > bounds.minX + margin && x < bounds.maxX - margin && z > bounds.minZ + margin && z < bounds.maxZ - margin
      && geometry.wallDistance(x, z, margin) >= margin,
    waypoint(x, z, gx, gz, heading) {
      const path = route(x, z, gx, gz, heading);
      if (!path) return null;
      let i = 0;
      while (i < path.length - 1 && Math.hypot(path[i]!.x - x, path[i]!.z - z) < REACH_M) i += 1;
      return path[i]!;
    },
    coverSpot(x, z, tx, tz) {
      let best: { x: number; z: number } | null = null;
      let bestD = INF;
      for (const spot of spots) {
        const d = Math.hypot(spot.x - x, spot.z - z);
        if (d > COVER_SEARCH_M || d >= bestD || Math.hypot(spot.x - tx, spot.z - tz) < 14 || geometry.clear(spot.x, spot.z, tx, tz)) continue;
        best = spot;
        bestD = d;
      }
      return best;
    },
  };
}

/**
 * A bot driver: chases the nearest threat (favouring the player), weaves while it fires, grabs
 * pickups when hurt or empty, ducks behind cover when badly hurt, and backs out when stuck.
 * All randomness comes from the seed it was built with, so a seeded match replays exactly.
 */
export function createBotBrain(seed: number): BotBrain {
  const rng = createRng(seed);
  let weaveUntil = 0;
  let weaveDir = 1;
  let coverUntil = 0;
  let coverReadyAt = 0;
  let stuck = 0;
  let reverseUntil = 0;
  let reverseSteer = 1;

  return {
    think(view): BotCommand {
      const { self, tick, layout, nav } = view;
      const lineOk = (ax: number, az: number, bx: number, bz: number): boolean => (nav ? nav.clear(ax, az, bx, bz) : lineClear(layout, ax, az, bx, bz));
      const command: BotCommand = { steer: 0, throttle: 0, brake: false, fire: false, missile: false, special: false };
      if (!self.alive) return command;

      const enemies = view.vehicles.filter((v) => v.alive && v.playerId !== self.playerId);
      let target: CombatVehicleState | null = null;
      let best = Infinity;
      for (const enemy of enemies) {
        const score = Math.hypot(enemy.x - self.x, enemy.z - self.z) * (enemy.bot ? 1 : 0.45);
        if (score < best) {
          best = score;
          target = enemy;
        }
      }
      const distance = target ? Math.hypot(target.x - self.x, target.z - self.z) : Infinity;
      const healthFraction = self.health / self.maxHealth;
      const lowHealth = healthFraction < LOW_HEALTH;

      const readyPad = (kind: "health" | "ammo"): PickupState | undefined => view.pickups.find((p) => p.kind === kind && p.ready);
      let goal: { x: number; z: number } | null = null;
      let holdPosition = false;
      const healthPad = lowHealth ? readyPad("health") : undefined;
      const ammoPad = self.missiles === 0 && (!target || distance > 14) ? readyPad("ammo") : undefined;
      if (healthPad) goal = healthPad;
      else if (ammoPad) goal = ammoPad;
      else if (lowHealth && target && tick >= coverReadyAt) {
        if (coverUntil === 0) coverUntil = tick + COVER_TICKS;
        if (tick >= coverUntil) {
          coverReadyAt = tick + COVER_COOLDOWN_TICKS;
          coverUntil = 0;
          goal = target;
        } else if (nav) {
          // In a city, cover is a street spot the threat cannot see.
          const spot = nav.coverSpot(self.x, self.z, target.x, target.z);
          goal = spot ?? target;
          holdPosition = spot !== null && Math.hypot(spot.x - self.x, spot.z - self.z) < 3;
        } else {
          let nearest = layout.obstacles[0];
          let nearestDistance = Infinity;
          for (const box of layout.obstacles) {
            const d = Math.hypot(box.x - self.x, box.z - self.z);
            if (d < nearestDistance) {
              nearestDistance = d;
              nearest = box;
            }
          }
          const awayX = nearest.x - target.x;
          const awayZ = nearest.z - target.z;
          const awayLength = Math.hypot(awayX, awayZ) || 1;
          const reach = Math.max(nearest.halfX, nearest.halfZ) + 2.5;
          goal = { x: nearest.x + (awayX / awayLength) * reach, z: nearest.z + (awayZ / awayLength) * reach };
          holdPosition = Math.hypot(goal.x - self.x, goal.z - self.z) < 2;
        }
      } else if (target) {
        goal = target;
      }

      // Weave: alternate aiming straight (to shoot) with a sideways drift.
      if (tick >= weaveUntil) {
        weaveDir = rng() < 0.5 ? -1 : 1;
        weaveUntil = tick + 40 + Math.floor(rng() * 60);
      }
      const weaving = target !== null && goal === target && distance < 24 && (weaveUntil - tick) % 100 < 35;

      if (stuck >= STUCK_TICKS && tick >= reverseUntil) {
        reverseUntil = tick + REVERSE_TICKS;
        reverseSteer = rng() < 0.5 ? -1 : 1;
        stuck = 0;
      }
      if (tick < reverseUntil) {
        command.throttle = -1;
        command.steer = reverseSteer;
        return command;
      }

      let desired = self.heading;
      if (goal) {
        // By street unless the way to the goal is open: buildings are walls, so go round them.
        let aim: { x: number; z: number } = goal;
        if (nav && !nav.clear(self.x, self.z, goal.x, goal.z)) aim = nav.waypoint(self.x, self.z, goal.x, goal.z, self.heading) ?? goal;
        desired = Math.atan2(aim.x - self.x, aim.z - self.z);
        if (weaving) desired += weaveDir * 0.55;
        // Look ahead for cover or walls and swing wide when the way is blocked.
        const lookAhead = nav ? 7 + Math.abs(self.speed) * 0.45 : 7;
        const probe = (angle: number): boolean => {
          const px = self.x + Math.sin(angle) * lookAhead;
          const pz = self.z + Math.cos(angle) * lookAhead;
          if (nav) return nav.clear(self.x, self.z, px, pz) && nav.open(px, pz, 2.5);
          if (Math.abs(px) > layout.halfExtent - 3 || Math.abs(pz) > layout.halfExtent - 3) return false;
          return lineClear(layout, self.x, self.z, px, pz) && layout.obstacles.every((o) => Math.abs(px - o.x) > o.halfX + 1.5 || Math.abs(pz - o.z) > o.halfZ + 1.5);
        };
        if (!probe(desired)) {
          const options = [0.8, -0.8, 1.6, -1.6];
          const swing = options.map((o) => desired + o).find((angle) => probe(angle));
          if (swing !== undefined) desired = swing;
        }
        const error = wrap(desired - self.heading);
        command.steer = clamp(-error * 2.5, -1, 1);
        const arrived = Math.hypot(goal.x - self.x, goal.z - self.z) < 3;
        // Lift for a corner: a city car at full speed cannot make a right angle between walls.
        const corner = nav !== undefined && Math.abs(error) > 0.6 && Math.abs(self.speed) > 14;
        command.throttle = holdPosition || (arrived && goal !== target) ? 0 : Math.abs(error) > 1.4 ? 0.3 : corner ? 0.35 : distance < 9 && goal === target ? 0.4 : 1;
        if (nav && Math.abs(error) > 0.6 && self.speed > (Math.abs(error) > 1.4 ? 9 : 18)) {
          // Turning round, or into a side street: shed speed first so the car stays on the road.
          command.throttle = 0;
          command.brake = true;
        }
        if (holdPosition) command.brake = true;
      }

      if (command.throttle > 0.2 && Math.abs(self.speed) < 1.5) stuck += 1;
      else stuck = Math.max(0, stuck - 2);

      if (target && tick >= BOT_GRACE_TICKS) {
        const aim = wrap(Math.atan2(target.x - self.x, target.z - self.z) - self.heading);
        const clear = lineOk(self.x, self.z, target.x, target.z);
        command.fire = distance < GUN_RANGE && Math.abs(aim) < GUN_ALIGNMENT && clear;
        command.missile = self.missiles > 0 && self.lockId !== null && distance > 9 && rng() < 0.05;
        command.special =
          self.specialCooldown === 0 &&
          (self.special === "repair" ? healthFraction < 0.55 : self.special === "shockwave" ? distance < 9 : distance > 18 || lowHealth);
      }
      return command;
    },
  };
}
