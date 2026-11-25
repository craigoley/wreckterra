import { lineClear } from "./arena";
import { difficultyRules, type BotRules } from "./difficulty";
import type { CombatArenaLayout, CombatVehicleState, PickupState } from "./contracts";
import type { CityData } from "../maps/city-compiler";
import { createSpatialIndex } from "../maps/spatial-index";
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
  /**
   * Where to steer to stay on the lane centre when travelling by street to a goal: a point a short
   * look-ahead along the street path, and the next sharp corner on it (how far, how sharp) if any.
   */
  steer(x: number, z: number, gx: number, gz: number, heading: number, speed: number): { x: number; z: number; corner?: { distance: number; angle: number } } | null;
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

const GUN_RANGE = 30;
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
/** Look-ahead on the lane centre: this far, plus this much per m/s of speed. */
const LANE_LOOKAHEAD_M = 7;
const LANE_LOOKAHEAD_PER_MS = 0.35;
/** A turn sharper than this (radians) at a junction is a corner worth braking for. */
const CORNER_MIN_ANGLE = 0.5;
const CORNER_SCAN_M = 90;
/** Inside this distance, with nothing in the way, a bot drives straight at its goal instead of by street. */
const DIRECT_M = 26;
/** The braking a bot plans a corner with, m/s squared: well under what the car can do. */
const PLANNED_BRAKE = 24;
/** Cell edge of the street-segment grid, metres. */
const SNAP_CELL_M = 32;

/**
 * Street routing for a city match. Streets are treated as two-way (a wreck-fest ignores one-way
 * signs), all-pairs shortest paths are precomputed once, and a trip is snapped onto the nearest
 * street segment at both ends, so asking for the next waypoint is a handful of lookups.
 */
export function createStreetNav(city: CityData, geometry: CityGeometry): BotNav {
  const nodes = city.graph.nodes;
  const count = nodes.length;
  // Flat typed arrays: the all-pairs sweep below is n cubed, so it must not chase nested arrays.
  const dist = new Float64Array(count * count).fill(INF);
  const next = new Int32Array(count * count).fill(-1);
  for (let i = 0; i < count; i += 1) dist[i * count + i] = 0;
  const seen = new Set<string>();
  const segments: { a: number; b: number }[] = [];
  for (const e of city.graph.edges) {
    const key = e.from < e.to ? `${e.from}-${e.to}` : `${e.to}-${e.from}`;
    if (e.from === e.to || seen.has(key)) continue;
    seen.add(key);
    segments.push({ a: e.from, b: e.to });
    dist[e.from * count + e.to] = e.length;
    dist[e.to * count + e.from] = e.length;
    next[e.from * count + e.to] = e.to;
    next[e.to * count + e.from] = e.from;
  }
  for (let k = 0; k < count; k += 1) {
    for (let i = 0; i < count; i += 1) {
      const ik = dist[i * count + k]!;
      if (ik === INF) continue;
      for (let j = 0; j < count; j += 1) {
        const through = ik + dist[k * count + j]!;
        if (through < dist[i * count + j]!) {
          dist[i * count + j] = through;
          next[i * count + j] = next[i * count + k]!;
        }
      }
    }
  }

  // Segments are filed in a grid, so snapping a car to the street looks at the few nearest ones.
  const segmentGrid = createSpatialIndex(city.bounds, SNAP_CELL_M, segments.length);
  segments.forEach((s, i) => {
    const a = nodes[s.a]!;
    const b = nodes[s.b]!;
    segmentGrid.insert(i, Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z));
  });
  /** Where on street segment `i` the point (x, z) lands, as a fraction of its length. */
  const along = (i: number, x: number, z: number): number => {
    const a = nodes[segments[i]!.a]!;
    const b = nodes[segments[i]!.b]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    return len2 === 0 ? 0 : clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1);
  };
  const distanceToSegment = (i: number, x: number, z: number): number => {
    const a = nodes[segments[i]!.a]!;
    const b = nodes[segments[i]!.b]!;
    const t = along(i, x, z);
    return Math.hypot(x - (a.x + (b.x - a.x) * t), z - (a.z + (b.z - a.z) * t));
  };
  const snap = (x: number, z: number): { seg: number; x: number; z: number } => {
    const found = segmentGrid.nearest(x, z, (i) => distanceToSegment(i, x, z));
    if (!found) return { seg: -1, x, z };
    const a = nodes[segments[found.id]!.a]!;
    const b = nodes[segments[found.id]!.b]!;
    const t = along(found.id, x, z);
    return { seg: found.id, x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  };

  /** The street path to a goal: the car's own spot on the nearest street, then junctions, then the goal's spot. */
  const route = (x: number, z: number, gx: number, gz: number, heading?: number): { start: { x: number; z: number }; path: { x: number; z: number }[] } | null => {
    const from = snap(x, z);
    const to = snap(gx, gz);
    if (from.seg < 0 || to.seg < 0) return null;
    const start = { x: from.x, z: from.z };
    if (from.seg === to.seg) return { start, path: [{ x: to.x, z: to.z }] };
    let bestCost = INF;
    let bestS = -1;
    let bestE = -1;
    for (const s of [segments[from.seg]!.a, segments[from.seg]!.b]) {
      for (const e of [segments[to.seg]!.a, segments[to.seg]!.b]) {
        const behind = heading !== undefined && (nodes[s]!.x - x) * Math.sin(heading) + (nodes[s]!.z - z) * Math.cos(heading) < 0;
        const cost = Math.hypot(nodes[s]!.x - from.x, nodes[s]!.z - from.z) + dist[s * count + e]! + Math.hypot(nodes[e]!.x - to.x, nodes[e]!.z - to.z) + (behind ? U_TURN_M : 0);
        if (cost < bestCost) { bestCost = cost; bestS = s; bestE = e; }
      }
    }
    if (bestS < 0) return null;
    const path = [{ x: nodes[bestS]!.x, z: nodes[bestS]!.z }];
    for (let at = bestS; at !== bestE;) {
      at = next[at * count + bestE]!;
      path.push({ x: nodes[at]!.x, z: nodes[at]!.z });
    }
    path.push({ x: to.x, z: to.z });
    return { start, path };
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
      const path = route(x, z, gx, gz, heading)?.path;
      if (!path) return null;
      let i = 0;
      while (i < path.length - 1 && Math.hypot(path[i]!.x - x, path[i]!.z - z) < REACH_M) i += 1;
      return path[i]!;
    },
    steer(x, z, gx, gz, heading, speed) {
      const lane = route(x, z, gx, gz, heading);
      if (!lane) return null;
      // Pure pursuit on the lane centre: aim a look-ahead past the car's own spot on the street, so a
      // car that has drifted to the kerb, or been shoved off, swings back onto the lane by itself.
      const reach = LANE_LOOKAHEAD_M + Math.abs(speed) * LANE_LOOKAHEAD_PER_MS;
      const points = [lane.start, ...lane.path];
      let aim = points[points.length - 1]!;
      let aimed = false;
      let corner: { distance: number; angle: number } | undefined;
      let travelled = 0;
      for (let k = 0; k + 1 < points.length && travelled < CORNER_SCAN_M && !(aimed && corner); k += 1) {
        const a = points[k]!;
        const b = points[k + 1]!;
        const leg = Math.hypot(b.x - a.x, b.z - a.z);
        if (leg < 1e-6) continue;
        if (!aimed && travelled + leg >= reach) {
          const t = (reach - travelled) / leg;
          aim = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
          aimed = true;
        }
        const c = points[k + 2];
        if (!corner && c) {
          const turn = Math.abs(wrap(Math.atan2(c.x - b.x, c.z - b.z) - Math.atan2(b.x - a.x, b.z - a.z)));
          if (turn > CORNER_MIN_ANGLE) corner = { distance: travelled + leg, angle: turn };
        }
        travelled += leg;
      }
      return { x: aim.x, z: aim.z, corner };
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

/** The speed a car can hold through a junction turn of this angle (radians) without leaving the street. */
function cornerSpeed(angle: number): number {
  return angle > 1.2 ? 8 : angle > 0.8 ? 11 : 15;
}

/**
 * A bot driver: chases the nearest threat (favouring the player), weaves while it fires, grabs
 * pickups when hurt or empty, ducks behind cover when badly hurt, and backs out when stuck.
 * All randomness comes from the seed it was built with, so a seeded match replays exactly. The rules
 * (a difficulty level) set how soon it fires, how true it aims and how often it launches a missile.
 */
export function createBotBrain(seed: number, rules: BotRules = difficultyRules()): BotBrain {
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
        // By street, along the lane centre, unless the goal is close and in plain sight: then straight at it.
        let aim: { x: number; z: number } = goal;
        let ahead: { distance: number; angle: number } | undefined;
        const toGoal = Math.hypot(goal.x - self.x, goal.z - self.z);
        if (nav && !(toGoal < DIRECT_M && nav.clear(self.x, self.z, goal.x, goal.z))) {
          const lane = nav.steer(self.x, self.z, goal.x, goal.z, self.heading, self.speed);
          if (lane) {
            aim = lane;
            ahead = lane.corner;
          }
        }
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
        if (ahead && self.speed > cornerSpeed(ahead.angle) && (self.speed ** 2 - cornerSpeed(ahead.angle) ** 2) / (2 * PLANNED_BRAKE) >= ahead.distance - 3) {
          // A sharp junction is coming up faster than the car can take it: shed the speed now.
          command.throttle = 0;
          command.brake = true;
        }
        if (holdPosition) command.brake = true;
      }

      if (command.throttle > 0.2 && Math.abs(self.speed) < 1.5) stuck += 1;
      else stuck = Math.max(0, stuck - 2);

      if (target && tick >= rules.botGraceTicks) {
        const aim = wrap(Math.atan2(target.x - self.x, target.z - self.z) - self.heading);
        const clear = lineOk(self.x, self.z, target.x, target.z);
        command.fire = distance < GUN_RANGE && Math.abs(aim) < rules.botGunAlignment && clear;
        command.missile = self.missiles > 0 && self.lockId !== null && distance > 9 && rng() < rules.botMissileChance;
        command.special =
          self.specialCooldown === 0 &&
          (self.special === "repair" ? healthFraction < 0.55 : self.special === "shockwave" ? distance < 9 : distance > 18 || lowHealth);
      }
      return command;
    },
  };
}
