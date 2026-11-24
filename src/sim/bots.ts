import { lineClear } from "./arena";
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
   * Pure pursuit along the lane centres of the street trip to a goal: the car's own spot on the nearest
   * lane is the start, so a car shoved off the street heads back to it. `near` is `ahead` metres along
   * the lane and `far` is `farther` metres along, for judging how sharp the next turn is. Null with no route.
   */
  lane(x: number, z: number, gx: number, gz: number, heading: number, ahead: number, farther: number): { near: { x: number; z: number }; far: { x: number; z: number } } | null;
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

/** One street-graph leg: the node it ends at and how long it is. */
interface Leg { to: number; length: number }
/** Shortest distances to one node and the first hop towards it from every other node. */
interface Row { dist: Float64Array; next: Int32Array }

/**
 * Street routing for a city match. Streets are treated as two-way (a wreck-fest ignores one-way
 * signs). A shortest-path tree is grown from a destination node the first time a trip ends there and
 * kept, and a trip is snapped onto the nearest street segment at both ends through a grid over the
 * segments, so asking for the next waypoint costs a handful of lookups however big the district is.
 */
export function createStreetNav(city: CityData, geometry: CityGeometry): BotNav {
  const nodes = city.graph.nodes;
  const count = nodes.length;
  const adjacent: Leg[][] = Array.from({ length: count }, () => []);
  const seen = new Set<string>();
  const segments: { a: number; b: number }[] = [];
  for (const e of city.graph.edges) {
    const key = e.from < e.to ? `${e.from}-${e.to}` : `${e.to}-${e.from}`;
    if (e.from === e.to || seen.has(key)) continue;
    seen.add(key);
    segments.push({ a: e.from, b: e.to });
    adjacent[e.from]!.push({ to: e.to, length: e.length });
    adjacent[e.to]!.push({ to: e.from, length: e.length });
  }

  const rows = new Map<number, Row>();
  const rowTo = (goal: number): Row => {
    const cached = rows.get(goal);
    if (cached) return cached;
    const dist = new Float64Array(count).fill(INF);
    const next = new Int32Array(count).fill(-1);
    const done = new Uint8Array(count);
    dist[goal] = 0;
    // A binary heap of [distance, node]; stale entries are skipped when popped.
    const heap: [number, number][] = [[0, goal]];
    const push = (item: [number, number]): void => {
      heap.push(item);
      for (let i = heap.length - 1; i > 0;) {
        const parent = (i - 1) >> 1;
        if (heap[parent]![0] <= heap[i]![0]) break;
        [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
        i = parent;
      }
    };
    const pop = (): [number, number] => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        for (let i = 0;;) {
          const [l, r] = [2 * i + 1, 2 * i + 2];
          let m = i;
          if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
          if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i]!, heap[m]!];
          i = m;
        }
      }
      return top;
    };
    while (heap.length > 0) {
      const [d, at] = pop();
      if (done[at]) continue;
      done[at] = 1;
      for (const leg of adjacent[at]!) {
        if (d + leg.length < dist[leg.to]!) {
          dist[leg.to] = d + leg.length;
          // Streets are two-way, so the hop towards the goal from `leg.to` is back to `at`.
          next[leg.to] = at;
          push([dist[leg.to]!, leg.to]);
        }
      }
    }
    const row = { dist, next };
    rows.set(goal, row);
    return row;
  };

  // A grid over the street segments: the nearest one is found among the few near the point.
  const segmentBoxes = segments.map((sg) => {
    const a = nodes[sg.a]!;
    const b = nodes[sg.b]!;
    return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) };
  });
  const segmentIndex = createSpatialIndex(segmentBoxes);

  const snap = (x: number, z: number): { seg: number; x: number; z: number } => {
    let best = { seg: -1, x, z };
    let bestD = INF;
    if (segments.length === 0) return best;
    // Widen the search until a segment is found inside it: that one is then the nearest.
    for (let reach = 40; reach < 1e6; reach *= 2) {
      for (const i of segmentIndex.query(x - reach, z - reach, x + reach, z + reach)) {
        const s = segments[i]!;
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
      }
      if (bestD <= reach) break;
    }
    return best;
  };

  /** The street trip from here to there: where it joins the street, then each junction, then where it ends. */
  const route = (x: number, z: number, gx: number, gz: number, heading?: number): { start: { x: number; z: number }; path: { x: number; z: number }[] } | null => {
    const from = snap(x, z);
    const to = snap(gx, gz);
    if (from.seg < 0 || to.seg < 0) return null;
    const start = { x: from.x, z: from.z };
    if (from.seg === to.seg) return { start, path: [{ x: to.x, z: to.z }] };
    let bestCost = INF;
    let bestS = -1;
    let bestE = -1;
    for (const e of [segments[to.seg]!.a, segments[to.seg]!.b]) {
      const row = rowTo(e);
      for (const s of [segments[from.seg]!.a, segments[from.seg]!.b]) {
        const behind = heading !== undefined && (nodes[s]!.x - x) * Math.sin(heading) + (nodes[s]!.z - z) * Math.cos(heading) < 0;
        const cost = Math.hypot(nodes[s]!.x - from.x, nodes[s]!.z - from.z) + row.dist[s]! + Math.hypot(nodes[e]!.x - to.x, nodes[e]!.z - to.z) + (behind ? U_TURN_M : 0);
        if (cost < bestCost) { bestCost = cost; bestS = s; bestE = e; }
      }
    }
    if (bestS < 0) return null;
    const path = [{ x: nodes[bestS]!.x, z: nodes[bestS]!.z }];
    const row = rowTo(bestE);
    for (let at = bestS; at !== bestE;) {
      at = row.next[at]!;
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
    lane(x, z, gx, gz, heading, ahead, farther) {
      const trip = route(x, z, gx, gz, heading);
      if (!trip) return null;
      const points = [trip.start, ...trip.path];
      // Where the car is on its lane, then a point `ahead` metres further along the lane centre.
      let bestK = 0;
      let bestT = 0;
      let bestD = INF;
      for (let k = 0; k + 1 < points.length; k += 1) {
        const a = points[k]!;
        const b = points[k + 1]!;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len2 = dx * dx + dz * dz;
        const t = len2 === 0 ? 0 : clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1);
        const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
        if (d < bestD) { bestD = d; bestK = k; bestT = t; }
      }
      const along = (distance: number): { x: number; z: number } => {
        let k = bestK;
        let px = points[k]!.x + (points[k + 1]!.x - points[k]!.x) * bestT;
        let pz = points[k]!.z + (points[k + 1]!.z - points[k]!.z) * bestT;
        let left = distance;
        while (k + 1 < points.length) {
          const e = points[k + 1]!;
          const d = Math.hypot(e.x - px, e.z - pz);
          if (d >= left && d > 0) return { x: px + ((e.x - px) * left) / d, z: pz + ((e.z - pz) * left) / d };
          left -= d;
          px = e.x;
          pz = e.z;
          k += 1;
        }
        return { x: px, z: pz };
      };
      return { near: along(ahead), far: along(farther) };
    },
    waypoint(x, z, gx, gz, heading) {
      const trip = route(x, z, gx, gz, heading);
      if (!trip) return null;
      const path = trip.path;
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
