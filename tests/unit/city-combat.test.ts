import { readFileSync } from "node:fs";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "../../src/App";
import { effectsFromEvents } from "../../src/game/CombatEffects";
import type { Building, CityData, Spawn } from "../../src/maps/city-compiler";
import { parseCity } from "../../src/maps/midtown";
import { createBotBrain, createStreetNav, type BotCommand } from "../../src/sim/bots";
import {
  createCityMatch, GUN_DAMAGE, MATCH_TICKS, MISSILE_DAMAGE, MISSILE_START_AMMO, PICKUP_RESPAWN_TICKS, PLAYER_ID, SPECIAL_COOLDOWN_TICKS,
} from "../../src/sim/combat";
import { CONTRACT_VERSION, TICK_RATE, type CombatAuthority, type CombatSnapshot, type SimEvent } from "../../src/sim/contracts";
import { createCityGeometry } from "../../src/sim/world";

afterEach(cleanup);

const city: CityData = parseCity(JSON.parse(readFileSync("public/maps/midtown/city.json", "utf8")));
const geometry = createCityGeometry(city);
const IDLE_INPUT: BotCommand = { steer: 0, throttle: 0, brake: false, fire: false, missile: false, special: false };

function tickOnce(match: CombatAuthority, command: Partial<BotCommand> = {}): SimEvent[] {
  const s = match.snapshot();
  expect(match.submitInput({ v: CONTRACT_VERSION, tick: s.tick, playerId: PLAYER_ID, ...IDLE_INPUT, ...command })).toEqual({ accepted: true });
  match.advance(1 / TICK_RATE);
  return match.drainEvents();
}

const me = (s: CombatSnapshot) => s.vehicles[0]!;

function goTo(s: CombatSnapshot, x: number, z: number): Partial<BotCommand> {
  const car = me(s);
  let error = Math.atan2(x - car.x, z - car.z) - car.heading;
  while (error > Math.PI) error -= Math.PI * 2;
  while (error < -Math.PI) error += Math.PI * 2;
  return { steer: Math.max(-1, Math.min(1, -error * 2.5)), throttle: Math.abs(error) > 1.4 ? 0.3 : 1 };
}

const withSpawns = (spawns: Spawn[], buildings: Building[] = city.buildings): CityData => ({ ...city, spawns, buildings });

/** Two cars facing each other down the long straight of West 57th Street, `gap` metres apart. */
function duel(gap: number): CityData {
  const road = city.roads.find((r) => r.name === "West 57th Street")!;
  const [a, b] = [road.points[1]!, road.points[2]!];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const [ux, uz] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const heading = Math.atan2(ux, uz);
  const start = { x: a[0] + ux * 60, z: a[1] + uz * 60 };
  return withSpawns([
    { x: start.x, z: start.z, heading },
    { x: start.x + ux * gap, z: start.z + uz * gap, heading: heading + Math.PI },
  ]);
}

const building = (id: number, footprint: [number, number][]): Building => ({ id, footprint, height: 30, heightSource: "height" });
const BLOCK = building(9001, [[-10, -10], [10, -10], [10, 10], [-10, 10]]);
/** Player at the west, bot at the east, 4 m either side of a 20 m block, on a line that runs through the middle of `buildings`. */
const across = (buildings: Building[]): CityData => withSpawns([{ x: -14, z: 0, heading: Math.PI / 2 }, { x: 14, z: 0, heading: -Math.PI / 2 }], buildings);

describe("WRECK-T12: fight bots through the real city streets", () => {
  it("WRECK-T12: a city match starts on road spawns and keeps the combat rules", () => {
    const match = createCityMatch(city, { seed: 5 });
    const s = match.snapshot();
    expect(s.match).toMatchObject({ status: "running", botsAlive: 4, endedTick: null });
    expect(s.vehicles.map((v) => v.playerId)).toEqual([PLAYER_ID, "bot-1", "bot-2", "bot-3", "bot-4"]);
    expect(s.vehicles.filter((v) => v.bot)).toHaveLength(4);
    // Everyone starts on a road spawn of the compiled city, clear of every building, all different.
    expect(me(s)).toMatchObject({ x: city.spawns[0]!.x, z: city.spawns[0]!.z, heading: city.spawns[0]!.heading });
    for (const car of s.vehicles) {
      expect(city.spawns.some((p) => p.x === car.x && p.z === car.z && p.heading === car.heading)).toBe(true);
      expect(geometry.onRoad(car.x, car.z)).toBe(true);
      expect(geometry.solidAt(car.x, car.z)).toBe(false);
      expect(car).toMatchObject({ alive: true, missiles: MISSILE_START_AMMO, specialCooldown: 0 });
      expect(car.health).toBe(car.maxHealth);
    }
    expect(new Set(s.vehicles.map((v) => `${v.x},${v.z}`)).size).toBe(5);
    // Three distinct vehicles, each with its own health and special.
    const kinds = (["switchback", "rivet", "voltage"] as const).map((k) => me(createCityMatch(city, { seed: 1, playerVehicle: k }).snapshot()));
    expect(new Set(kinds.map((k) => k.maxHealth)).size).toBe(3);
    expect(new Set(kinds.map((k) => k.special)).size).toBe(3);
    // The district is solid: every building is an obstacle, and pickups sit on road junctions.
    expect(match.layout.obstacles).toHaveLength(city.buildings.length);
    expect(s.pickups.map((p) => p.kind).sort()).toEqual(expect.arrayContaining(["ammo", "health"]));
    expect(new Set(s.pickups.map((p) => p.id)).size).toBe(s.pickups.length);
    for (const pad of s.pickups) {
      expect(pad.ready).toBe(true);
      expect(city.graph.nodes.some((n) => Math.hypot(n.x - pad.x, n.z - pad.z) < 1)).toBe(true);
    }
    // Same seed, same match; a different seed deals the bots out differently.
    expect(createCityMatch(city, { seed: 5 }).snapshot()).toEqual(s);
    expect(createCityMatch(city, { seed: 6 }).snapshot().vehicles.map((v) => `${v.kind}${v.x}`)).not.toEqual(s.vehicles.map((v) => `${v.kind}${v.x}`));
    // Inputs stay validated against the versioned contract.
    const ok = { v: CONTRACT_VERSION, tick: 0, playerId: PLAYER_ID, steer: 0, throttle: 0, brake: false };
    expect(match.submitInput({ ...ok, fire: true, missile: true, special: false })).toEqual({ accepted: true });
    expect(match.submitInput({ ...ok, fire: "yes" })).toEqual({ accepted: false, reason: "bad-shape" });
    expect(match.submitInput({ ...ok, v: 2 })).toEqual({ accepted: false, reason: "bad-version" });
    expect(match.submitInput({ ...ok, playerId: "bot-1" })).toEqual({ accepted: false, reason: "unknown-player" });

    // Guns hurt by exactly what the hit reports.
    const gun = createCityMatch(duel(28), { seed: 1, bots: 1 });
    let dealt = 0;
    let hits = 0;
    for (let i = 0; i < 90; i += 1) {
      for (const e of tickOnce(gun, { fire: true })) {
        if (e.kind === "hit" && e.playerId === PLAYER_ID && e.weapon === "gun") { expect(e.damage).toBe(GUN_DAMAGE); dealt += e.damage; hits += 1; }
      }
    }
    expect(hits).toBeGreaterThan(5);
    expect(gun.snapshot().vehicles[1]!.health).toBeCloseTo(gun.snapshot().vehicles[1]!.maxHealth - dealt, 6);

    // A locked missile spends one round and lands for its full damage.
    const rocket = createCityMatch(duel(28), { seed: 1, bots: 1 });
    tickOnce(rocket);
    expect(me(rocket.snapshot()).lockId).toBe("bot-1");
    const launched = tickOnce(rocket, { missile: true });
    expect(launched).toEqual([expect.objectContaining({ kind: "missile-launched", playerId: PLAYER_ID, targetId: "bot-1" })]);
    expect(me(rocket.snapshot()).missiles).toBe(MISSILE_START_AMMO - 1);
    const landed: SimEvent[] = [];
    for (let i = 0; i < 3 * TICK_RATE; i += 1) landed.push(...tickOnce(rocket));
    expect(landed.find((e) => e.kind === "hit" && e.weapon === "missile" && e.targetId === "bot-1")).toMatchObject({ damage: MISSILE_DAMAGE, playerId: PLAYER_ID });

    // The special fires once, then cools down.
    const special = createCityMatch(duel(28), { seed: 1, bots: 1, playerVehicle: "voltage" });
    expect(tickOnce(special, { special: true }).some((e) => e.kind === "special" && e.special === "afterburner")).toBe(true);
    expect(me(special.snapshot())).toMatchObject({ specialCooldown: SPECIAL_COOLDOWN_TICKS });
    expect(me(special.snapshot()).boost).toBeGreaterThan(0);

    // Pickups: ammo refills and respawns; health stays put for a car that is not hurt.
    const base = createCityMatch(city, { seed: 1 }).snapshot().pickups;
    const lone = (kind: "ammo" | "health", far: Spawn): { world: CityData; pad: { x: number; z: number; id: string } } => {
      const pad = base.find((p) => p.kind === kind)!;
      const node = city.graph.nodes.findIndex((n) => Math.hypot(n.x - pad.x, n.z - pad.z) < 1);
      const edge = city.graph.edges.find((e) => e.from === node)!;
      const next = city.graph.nodes[edge.to]!;
      const [ux, uz] = [(next.x - pad.x) / edge.length, (next.z - pad.z) / edge.length];
      const spawn = { x: pad.x + ux * 16, z: pad.z + uz * 16, heading: Math.atan2(-ux, -uz) };
      return { world: withSpawns([spawn, far]), pad };
    };
    const farthest = (from: { x: number; z: number }): Spawn => [...city.spawns].sort((a, b) => Math.hypot(b.x - from.x, b.z - from.z) - Math.hypot(a.x - from.x, a.z - from.z))[0]!;
    const padAmmo = base.find((p) => p.kind === "ammo")!;
    const ammoRun = lone("ammo", farthest(padAmmo));
    const ammo = createCityMatch(ammoRun.world, { seed: 3, bots: 1, playerVehicle: "rivet" });
    const picked: SimEvent[] = [];
    for (let i = 0; i < 10 * TICK_RATE && picked.length === 0; i += 1) picked.push(...tickOnce(ammo, goTo(ammo.snapshot(), ammoRun.pad.x, ammoRun.pad.z)).filter((e) => e.kind === "pickup"));
    expect(picked).toEqual([expect.objectContaining({ pickup: "ammo", padId: ammoRun.pad.id, playerId: PLAYER_ID })]);
    expect(me(ammo.snapshot()).missiles).toBe(MISSILE_START_AMMO + 3);
    expect(ammo.snapshot().pickups.find((p) => p.id === ammoRun.pad.id)).toMatchObject({ ready: false, respawnTicks: PICKUP_RESPAWN_TICKS });
    let ready = false;
    for (let i = 0; i < PICKUP_RESPAWN_TICKS + 5 && !ready; i += 1) ready = tickOnce(ammo, { brake: true }).some((e) => e.kind === "pickup-ready" && e.padId === ammoRun.pad.id);
    expect(ready).toBe(true);
    const healthRun = lone("health", farthest(base.find((p) => p.kind === "health")!));
    const health = createCityMatch(healthRun.world, { seed: 3, bots: 1, playerVehicle: "rivet" });
    for (let i = 0; i < 6 * TICK_RATE; i += 1) {
      expect(tickOnce(health, goTo(health.snapshot(), healthRun.pad.x, healthRun.pad.z)).some((e) => e.kind === "pickup")).toBe(false);
    }
    expect(health.snapshot().pickups.find((p) => p.id === healthRun.pad.id)?.ready).toBe(true);
  });

  it("WRECK-T12: bots hunt the player along the street graph", () => {
    const nav = createStreetNav(city, geometry);
    // The router hands out street-graph nodes: the first leg of a long trip is a junction, not the target.
    const from = city.spawns[0]!;
    const to = city.spawns[city.spawns.length - 1]!;
    const leg = nav.waypoint(from.x, from.z, to.x, to.z)!;
    expect(city.graph.nodes.some((n) => Math.hypot(n.x - leg.x, n.z - leg.z) < 0.5)).toBe(true);
    expect(nav.waypoint(from.x, from.z, from.x + 1, from.z + 1)).toBeTruthy();

    let blockedStarts = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const match = createCityMatch(city, { seed });
      const start = match.snapshot();
      for (const bot of start.vehicles.filter((v) => v.bot)) if (!geometry.clear(bot.x, bot.z, me(start).x, me(start).z)) blockedStarts += 1;
      let reached = -1;
      let onStreet = 0;
      let samples = 0;
      for (let i = 0; i < 30 * TICK_RATE && reached < 0; i += 1) {
        tickOnce(match);
        const s = match.snapshot();
        for (const bot of s.vehicles.filter((v) => v.bot && v.alive)) {
          const gap = Math.hypot(bot.x - me(s).x, bot.z - me(s).z);
          if (gap < 15) reached = i;
          if (gap > 30) { samples += 1; if (geometry.roadDistance(bot.x, bot.z) < 12) onStreet += 1; }
        }
      }
      expect(reached, `seed ${seed}: a bot reached the player`).toBeGreaterThanOrEqual(0);
      // On the way they stay on the streets rather than driving a straight line through blocks.
      expect(onStreet / Math.max(1, samples), `seed ${seed}: bots drive the streets`).toBeGreaterThan(0.9);
    }
    // At least some bots had to go round buildings to get a line on the player.
    expect(blockedStarts).toBeGreaterThan(0);
  });

  it("WRECK-T12: shots do not pass through buildings", () => {
    // Geometry: a ray stops at the near wall, a concave notch really is open, and inside counts as blocked.
    const walled = createCityGeometry(across([BLOCK]));
    expect(walled.rayCover(-30, 0, 1, 0)).toBeCloseTo(20, 6);
    expect(walled.rayCover(30, 0, -1, 0)).toBeCloseTo(20, 6);
    expect(walled.rayCover(-30, 0, -1, 0)).toBe(Infinity);
    expect(walled.rayCover(0, 0, 1, 0)).toBe(0);
    expect(walled.clear(-30, 0, 30, 0)).toBe(false);
    expect(walled.clear(-30, 15, 30, 15)).toBe(true);
    const ell = createCityGeometry(across([building(9002, [[-10, -10], [10, -10], [10, -4], [-4, -4], [-4, 10], [-10, 10]])]));
    expect(ell.clear(30, 6, 0, 6)).toBe(true);
    expect(ell.clear(30, 6, -20, 6)).toBe(false);
    expect(ell.solidAt(0, 6)).toBe(false);
    expect(ell.solidAt(-7, 6)).toBe(true);

    // Guns: with a building between the cars no round reaches the bot and no lock forms.
    const shoot = (world: CityData) => {
      const match = createCityMatch(world, { seed: 1, bots: 1 });
      const shots: Extract<SimEvent, { kind: "shot" }>[] = [];
      const hits: SimEvent[] = [];
      let locked = false;
      for (let i = 0; i < 20; i += 1) {
        for (const e of tickOnce(match, { fire: true })) {
          if (e.kind === "shot" && e.playerId === PLAYER_ID) shots.push(e);
          if (e.kind === "hit" && e.targetId === "bot-1") hits.push(e);
        }
        locked ||= me(match.snapshot()).lockId === "bot-1";
      }
      return { shots, hits, locked, bot: match.snapshot().vehicles[1]! };
    };
    const blocked = shoot(across([BLOCK]));
    expect(blocked.shots.length).toBeGreaterThan(0);
    for (const shot of blocked.shots) expect(shot.toX).toBeLessThan(-9.5);
    expect(blocked.hits).toEqual([]);
    expect(blocked.locked).toBe(false);
    expect(blocked.bot.health).toBe(blocked.bot.maxHealth);
    // Control: take the building away and the same shots land and the missile locks on.
    const open = shoot(across([]));
    expect(open.hits.length).toBeGreaterThan(0);
    expect(open.locked).toBe(true);

    // Missiles: one fired at a hidden bot bursts on the wall instead of passing through it.
    const rocket = createCityMatch(across([BLOCK]), { seed: 1, bots: 1 });
    const events = [...tickOnce(rocket, { missile: true })];
    expect(events.some((e) => e.kind === "missile-launched")).toBe(true);
    for (let i = 0; i < 2 * TICK_RATE; i += 1) events.push(...tickOnce(rocket));
    expect(events.filter((e) => e.kind === "hit" && e.targetId === "bot-1")).toEqual([]);
    expect(rocket.snapshot().missiles).toEqual([]);
  });

  it("WRECK-T12: a city match ends within five minutes and restarts", () => {
    // Standing still gets you wrecked inside the limit.
    const idle = createCityMatch(city, { seed: 2 });
    const idleEvents: SimEvent[] = [];
    for (let i = 0; i < MATCH_TICKS && idle.snapshot().match.status === "running"; i += 1) idleEvents.push(...tickOnce(idle));
    const lost = idle.snapshot();
    expect(lost.match).toMatchObject({ status: "lost", reason: "wrecked" });
    expect(lost.match.endedTick).toBeLessThanOrEqual(MATCH_TICKS);
    expect(me(lost)).toMatchObject({ alive: false, health: 0 });
    expect(idleEvents.filter((e) => e.kind === "match-ended")).toHaveLength(1);
    // A decided match stays decided.
    const frozen = idle.snapshot().vehicles;
    for (let i = 0; i < 120; i += 1) tickOnce(idle, { throttle: 1 });
    expect(idle.snapshot().match).toEqual(lost.match);
    expect(idle.snapshot().vehicles).toEqual(frozen);

    // A fighting player can win: the last car running ends the match as a win.
    for (const seed of [1, 2, 3]) {
      const duelNav = createStreetNav(city, geometry);
      const win = createCityMatch(city, { seed, bots: 1 });
      const brain = createBotBrain(99);
      const winEvents: SimEvent[] = [];
      for (let i = 0; i < MATCH_TICKS && win.snapshot().match.status === "running"; i += 1) {
        const s = win.snapshot();
        winEvents.push(...tickOnce(win, brain.think({ self: me(s), vehicles: s.vehicles, pickups: s.pickups, layout: win.layout, tick: s.tick, nav: duelNav })));
      }
      const won = win.snapshot();
      expect(won.match, `seed ${seed}`).toMatchObject({ status: "won", reason: "last-car-running", botsAlive: 0 });
      expect(won.match.endedTick).toBeLessThanOrEqual(MATCH_TICKS);
      expect(me(won).alive).toBe(true);
      expect(winEvents.filter((e) => e.kind === "match-ended")).toEqual([expect.objectContaining({ status: "won" })]);
      expect(winEvents.some((e) => e.kind === "wrecked" && e.playerId === "bot-1" && e.byId === PLAYER_ID)).toBe(true);
    }

    // A fighting player is also decided inside the limit, win or lose.
    const nav = createStreetNav(city, geometry);
    for (const seed of [1, 2, 3]) {
      const fight = createCityMatch(city, { seed });
      const brain = createBotBrain(99);
      for (let i = 0; i < MATCH_TICKS && fight.snapshot().match.status === "running"; i += 1) {
        const s = fight.snapshot();
        tickOnce(fight, brain.think({ self: me(s), vehicles: s.vehicles, pickups: s.pickups, layout: fight.layout, tick: s.tick, nav }));
      }
      const end = fight.snapshot().match;
      expect(end.status, `seed ${seed}`).not.toBe("running");
      expect(end.endedTick).toBeLessThanOrEqual(MATCH_TICKS);
    }

    // Restart is a fresh match from the same seed, which then replays exactly.
    const fresh = createCityMatch(city, { seed: 2 }).snapshot();
    expect(idle.snapshot()).not.toEqual(fresh);
    idle.restart();
    expect(idle.snapshot()).toEqual(fresh);
    expect(idle.snapshot().match).toMatchObject({ status: "running", endedTick: null, botsAlive: 4 });
    expect(idle.drainEvents().filter((e) => e.kind === "spawned")).toHaveLength(5);
    const twin = createCityMatch(city, { seed: 2 });
    for (let i = 0; i < 600; i += 1) { tickOnce(idle); tickOnce(twin); }
    expect(idle.snapshot()).toEqual(twin.snapshot());
  });

  it("WRECK-T12: combat events become visible effects", () => {
    const at = { v: CONTRACT_VERSION, tick: 7 } as const;
    const fx = effectsFromEvents([
      { ...at, kind: "shot", playerId: PLAYER_ID, x: 1, z: 2, toX: 3, toZ: 4 },
      { ...at, kind: "hit", playerId: PLAYER_ID, targetId: "bot-1", weapon: "gun", damage: 4, x: 3, z: 4 },
      { ...at, kind: "hit", playerId: PLAYER_ID, targetId: "bot-1", weapon: "missile", damage: 30, x: 5, z: 6 },
      { ...at, kind: "wrecked", playerId: "bot-1", byId: PLAYER_ID, x: 5, z: 6 },
      { ...at, kind: "missile-launched", playerId: PLAYER_ID, targetId: null },
      { ...at, kind: "spawned", playerId: PLAYER_ID },
    ]);
    const kinds = fx.map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(["muzzle", "tracer", "sparks", "explosion"]));
    expect(fx.filter((f) => f.kind === "explosion").length).toBeGreaterThanOrEqual(2);
    expect(fx.find((f) => f.kind === "tracer")).toMatchObject({ x: 1, z: 2, toX: 3, toZ: 4 });
    expect(effectsFromEvents([])).toEqual([]);
  });

  it("WRECK-T12: the app runs the city match with a HUD", () => {
    render(createElement(App));
    expect(screen.getByRole("meter", { name: "Your health" }).getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByText("Missiles 4/8")).toBeTruthy();
    expect(screen.getByText("Bots left 4/4")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
  });
});
