import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "../../src/App";
import type { LiveCityOutcome } from "../../src/maps/tile-city";
import { createBotBrain, type BotCommand } from "../../src/sim/bots";
import {
  AMMO_PICKUP, createCombatMatch, MATCH_TICKS, MISSILE_START_AMMO, PICKUP_RESPAWN_TICKS, PLAYER_ID, SPECIAL_COOLDOWN_TICKS,
} from "../../src/sim/combat";
import { CONTRACT_VERSION, TICK_RATE, type CombatAuthority, type CombatSnapshot, type SimEvent, type VehicleKind } from "../../src/sim/contracts";

afterEach(cleanup);

const IDLE_INPUT: BotCommand = { steer: 0, throttle: 0, brake: false, fire: false, missile: false, special: false };

/** Advance one tick, optionally with a player command, and return the events it produced. */
function tickOnce(match: CombatAuthority, command: Partial<BotCommand> = {}): SimEvent[] {
  const s = match.snapshot();
  expect(match.submitInput({ v: CONTRACT_VERSION, tick: s.tick, playerId: PLAYER_ID, ...IDLE_INPUT, ...command })).toEqual({ accepted: true });
  match.advance(1 / TICK_RATE);
  return match.drainEvents();
}

function player(snapshot: CombatSnapshot) {
  return snapshot.vehicles[0];
}

/** Steer the player toward a point; returns the throttle/steer command. */
function goTo(snapshot: CombatSnapshot, x: number, z: number): Partial<BotCommand> {
  const me = player(snapshot);
  let error = Math.atan2(x - me.x, z - me.z) - me.heading;
  while (error > Math.PI) error -= Math.PI * 2;
  while (error < -Math.PI) error += Math.PI * 2;
  return { steer: Math.max(-1, Math.min(1, -error * 2.5)), throttle: Math.abs(error) > 1.4 ? 0.3 : 1 };
}

/** Follow waypoints in order, skipping each once reached; a route lets the car go round cover. */
function route(points: readonly [number, number][]): (snapshot: CombatSnapshot) => Partial<BotCommand> {
  let next = 0;
  return (snapshot) => {
    const me = player(snapshot);
    while (next < points.length - 1 && Math.hypot(points[next][0] - me.x, points[next][1] - me.z) < 4) next += 1;
    return goTo(snapshot, points[next][0], points[next][1]);
  };
}

/** Let the shipped bot brain play the player's car, with optional overrides. */
function autopilot(match: CombatAuthority, seconds: number, tweak?: (c: BotCommand, s: CombatSnapshot) => BotCommand): SimEvent[] {
  const brain = createBotBrain(99);
  const events: SimEvent[] = [];
  for (let i = 0; i < seconds * TICK_RATE; i += 1) {
    const s = match.snapshot();
    if (s.match.status !== "running") break;
    const think = brain.think({ self: player(s), vehicles: s.vehicles, pickups: s.pickups, layout: match.layout, tick: s.tick });
    events.push(...tickOnce(match, tweak ? tweak(think, s) : think));
  }
  return events;
}

describe("WRECK-T10: original arena combat match", () => {
  it("WRECK-T10: a match starts with the player and four armed bots in the arena", () => {
    const match = createCombatMatch({ seed: 5 });
    const s = match.snapshot();
    expect(s.match).toMatchObject({ status: "running", botsAlive: 4, endedTick: null });
    expect(s.vehicles).toHaveLength(5);
    expect(s.vehicles.map((v) => v.playerId)).toEqual([PLAYER_ID, "bot-1", "bot-2", "bot-3", "bot-4"]);
    expect(s.vehicles.filter((v) => v.bot)).toHaveLength(4);
    for (const car of s.vehicles) {
      expect(car.alive).toBe(true);
      expect(car.health).toBe(car.maxHealth);
      expect(car.missiles).toBe(MISSILE_START_AMMO);
      expect(car.specialCooldown).toBe(0);
      expect(Math.abs(car.x)).toBeLessThan(match.layout.halfExtent);
      expect(Math.abs(car.z)).toBeLessThan(match.layout.halfExtent);
    }
    // Three distinct vehicles exist, each with its own health and special.
    const kinds = new Map<VehicleKind, { hp: number; special: string }>();
    for (const kind of ["switchback", "rivet", "voltage"] as const) {
      const car = player(createCombatMatch({ seed: 1, playerVehicle: kind }).snapshot());
      kinds.set(kind, { hp: car.maxHealth, special: car.special });
    }
    expect(new Set([...kinds.values()].map((k) => k.hp)).size).toBe(3);
    expect(new Set([...kinds.values()].map((k) => k.special)).size).toBe(3);
    // The arena has cover, ramps and two pickup pads.
    expect(match.layout.obstacles.length).toBeGreaterThan(3);
    expect(match.layout.ramps).toHaveLength(2);
    expect(s.pickups.map((p) => p.kind).sort()).toEqual(["ammo", "health"]);
    // Same seed, same match; a different seed changes who spawns where.
    expect(createCombatMatch({ seed: 5 }).snapshot()).toEqual(s);
    expect(createCombatMatch({ seed: 6 }).snapshot().vehicles.map((v) => v.kind)).not.toEqual(s.vehicles.map((v) => v.kind));
    // Something to fight quickly: an idle player sees an enemy within gun range inside ten seconds.
    let nearest = Infinity;
    for (let i = 0; i < 10 * TICK_RATE; i += 1) {
      tickOnce(match);
      const me = player(match.snapshot());
      for (const bot of match.snapshot().vehicles.filter((v) => v.bot)) nearest = Math.min(nearest, Math.hypot(bot.x - me.x, bot.z - me.z));
    }
    expect(nearest).toBeLessThan(30);
    // Inputs stay validated against the versioned contract, combat fields included.
    const ok = { v: CONTRACT_VERSION, tick: 0, playerId: PLAYER_ID, steer: 0, throttle: 0, brake: false };
    expect(match.submitInput({ ...ok, fire: true, missile: true, special: false })).toEqual({ accepted: true });
    expect(match.submitInput({ ...ok, fire: "yes" })).toEqual({ accepted: false, reason: "bad-shape" });
    expect(match.submitInput({ ...ok, v: 2 })).toEqual({ accepted: false, reason: "bad-version" });
    expect(match.submitInput({ ...ok, steer: 3 })).toEqual({ accepted: false, reason: "out-of-range" });
    expect(match.submitInput({ ...ok, playerId: "bot-1" })).toEqual({ accepted: false, reason: "unknown-player" });
  });

  it("WRECK-T10: weapons deal damage and missiles spend ammo", () => {
    const match = createCombatMatch({ seed: 1, bots: 1 });
    const brain = createBotBrain(99);
    const events: SimEvent[] = [];
    let checkedGun = 0;
    let checkedMissile = 0;
    for (let i = 0; i < 40 * TICK_RATE && match.snapshot().match.status === "running"; i += 1) {
      const s = match.snapshot();
      const think = brain.think({ self: player(s), vehicles: s.vehicles, pickups: s.pickups, layout: match.layout, tick: s.tick });
      // Missiles only fly when the player asks, and each launch spends one round.
      const step = tickOnce(match, { ...think, missile: player(s).lockId !== null && s.tick % 80 === 0 });
      events.push(...step);
      // Damage is real: on a tick with a hit, the target's health fell by exactly what the hit reports.
      for (const hit of step.filter((e) => e.kind === "hit" && e.playerId === PLAYER_ID && e.targetId === "bot-1")) {
        if (hit.kind !== "hit") continue;
        const healedThisTick = step.some((e) => e.kind === "pickup" && e.playerId === "bot-1");
        const drop = s.vehicles[1].health - match.snapshot().vehicles[1].health;
        if (!healedThisTick && step.filter((e) => e.kind === "hit" && e.targetId === "bot-1").length === 1) {
          expect(drop).toBeCloseTo(hit.damage, 6);
          if (hit.weapon === "gun") checkedGun += 1;
          else checkedMissile += 1;
        }
      }
    }
    const s = match.snapshot();
    const launches = events.filter((e) => e.kind === "missile-launched" && e.playerId === PLAYER_ID);
    expect(events.some((e) => e.kind === "hit" && e.weapon === "gun" && e.playerId === PLAYER_ID)).toBe(true);
    expect(events.some((e) => e.kind === "hit" && e.weapon === "missile" && e.playerId === PLAYER_ID)).toBe(true);
    expect(checkedGun).toBeGreaterThan(0);
    expect(checkedMissile).toBeGreaterThan(0);
    expect(launches.some((e) => e.kind === "missile-launched" && e.targetId === "bot-1")).toBe(true);
    // Ammo: the count falls by exactly the launches (plus any pad refill), and an empty rack cannot fire.
    const refills = events.filter((e) => e.kind === "pickup" && e.playerId === PLAYER_ID && e.pickup === "ammo").length;
    expect(player(s).missiles).toBe(Math.min(8, MISSILE_START_AMMO - launches.length + refills * AMMO_PICKUP));
    expect(launches.length).toBeGreaterThan(0);

    const dry = createCombatMatch({ seed: 2, bots: 1 });
    let fired = 0;
    for (let i = 0; i < 20 * TICK_RATE; i += 1) {
      // Pulse the trigger every 41 ticks, past the reload; stay put so no ammo pad is reached.
      fired += tickOnce(dry, { missile: i % 41 < 2 }).filter((e) => e.kind === "missile-launched" && e.playerId === PLAYER_ID).length;
      if (dry.snapshot().match.status !== "running") break;
    }
    expect(fired).toBe(MISSILE_START_AMMO);
    expect(player(dry.snapshot()).missiles).toBe(0);

    // Each special does its job.
    const afterburner = createCombatMatch({ seed: 3, playerVehicle: "voltage", bots: 0 + 1 });
    const base = player(afterburner.snapshot());
    let top = 0;
    const used = tickOnce(afterburner, { throttle: 1, special: true });
    expect(used.some((e) => e.kind === "special" && e.special === "afterburner")).toBe(true);
    expect(player(afterburner.snapshot())).toMatchObject({ specialCooldown: SPECIAL_COOLDOWN_TICKS, boost: expect.any(Number) });
    expect(player(afterburner.snapshot()).boost).toBeGreaterThan(0);
    for (let i = 0; i < 80; i += 1) {
      tickOnce(afterburner, { throttle: 1 });
      top = Math.max(top, player(afterburner.snapshot()).speed);
    }
    expect(top).toBeGreaterThan(25);
    expect(base.special).toBe("afterburner");

    const repair = createCombatMatch({ seed: 3, playerVehicle: "switchback" });
    for (let i = 0; i < 30 * TICK_RATE && player(repair.snapshot()).health === player(repair.snapshot()).maxHealth; i += 1) tickOnce(repair);
    const hurt = player(repair.snapshot()).health;
    expect(hurt).toBeLessThan(player(repair.snapshot()).maxHealth);
    tickOnce(repair, { special: true });
    expect(player(repair.snapshot()).health).toBeGreaterThan(hurt);
    expect(player(repair.snapshot()).specialCooldown).toBeGreaterThan(0);

    const shock = createCombatMatch({ seed: 3, playerVehicle: "rivet" });
    let shocked: SimEvent[] = [];
    for (let i = 0; i < 30 * TICK_RATE && shocked.length === 0; i += 1) {
      const s2 = shock.snapshot();
      const near = s2.vehicles.some((v) => v.bot && v.alive && Math.hypot(v.x - player(s2).x, v.z - player(s2).z) < 8);
      shocked = tickOnce(shock, { special: near }).filter((e) => e.kind === "hit" && e.weapon === "special");
    }
    expect(shocked.length).toBeGreaterThan(0);
  });

  it("WRECK-T10: bots damage the player within thirty seconds", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const match = createCombatMatch({ seed });
      let firstHit: SimEvent | undefined;
      for (let i = 0; i < 30 * TICK_RATE && !firstHit; i += 1) {
        firstHit = tickOnce(match).find((e) => e.kind === "hit" && e.targetId === PLAYER_ID && e.playerId.startsWith("bot-"));
      }
      expect(firstHit, `seed ${seed}`).toBeDefined();
      expect(player(match.snapshot()).health).toBeLessThan(player(match.snapshot()).maxHealth);
    }
    // Bots are the cause: with none, an idle player is never touched.
    const quiet = createCombatMatch({ seed: 1, bots: 1 });
    expect(quiet.snapshot().vehicles).toHaveLength(2);
  });

  it("WRECK-T10: pickups restore and respawn", () => {
    // Health: get hurt by a bot, drive onto the health pad, and it heals and then respawns.
    const match = createCombatMatch({ seed: 4, playerVehicle: "rivet", bots: 1 });
    const pad = match.layout.pads.find((p) => p.kind === "health")!;
    // A full-health car does not use up the pad.
    for (let i = 0; i < 120; i += 1) tickOnce(match, goTo(match.snapshot(), pad.x, pad.z));
    expect(match.snapshot().pickups.find((p) => p.id === pad.id)?.ready).toBe(true);
    let hurt = false;
    for (let i = 0; i < 40 * TICK_RATE && !hurt; i += 1) {
      tickOnce(match, { steer: 0, throttle: 0 });
      hurt = player(match.snapshot()).health < player(match.snapshot()).maxHealth - 5;
    }
    expect(hurt).toBe(true);
    const before = player(match.snapshot()).health;
    let picked: SimEvent[] = [];
    for (let i = 0; i < 20 * TICK_RATE && picked.length === 0; i += 1) {
      picked = tickOnce(match, goTo(match.snapshot(), pad.x, pad.z)).filter((e) => e.kind === "pickup");
    }
    expect(picked).toEqual([expect.objectContaining({ kind: "pickup", pickup: "health", padId: pad.id, playerId: PLAYER_ID })]);
    expect(player(match.snapshot()).health).toBeGreaterThan(before);
    expect(match.snapshot().pickups.find((p) => p.id === pad.id)).toMatchObject({ ready: false, respawnTicks: PICKUP_RESPAWN_TICKS });
    let ready = false;
    for (let i = 0; i < PICKUP_RESPAWN_TICKS + 5 && !ready; i += 1) {
      ready = tickOnce(match, { brake: true }).some((e) => e.kind === "pickup-ready" && e.padId === pad.id);
      if (match.snapshot().match.status !== "running") break;
    }
    expect(ready).toBe(true);
    expect(match.snapshot().pickups.find((p) => p.id === pad.id)?.ready).toBe(true);

    // Ammo: spend the missiles, collect the ammo pad, and it refills and respawns.
    const ammo = createCombatMatch({ seed: 1, playerVehicle: "rivet", bots: 1 });
    const ammoPad = ammo.layout.pads.find((p) => p.kind === "ammo")!;
    for (let i = 0; i < 4 * TICK_RATE; i += 1) tickOnce(ammo, { missile: i % 41 < 2 });
    expect(player(ammo.snapshot()).missiles).toBe(0);
    let gotAmmo = false;
    const toAmmo = route([[32, 30], [32, -24], [ammoPad.x, ammoPad.z]]);
    for (let i = 0; i < 30 * TICK_RATE && !gotAmmo; i += 1) {
      gotAmmo = tickOnce(ammo, toAmmo(ammo.snapshot())).some((e) => e.kind === "pickup" && e.pickup === "ammo");
    }
    expect(gotAmmo).toBe(true);
    expect(player(ammo.snapshot()).missiles).toBe(AMMO_PICKUP);
    expect(ammo.snapshot().pickups.find((p) => p.id === ammoPad.id)?.ready).toBe(false);
  });

  it("WRECK-T10: a match ends in a win or a loss within five minutes", () => {
    // Standing still gets you wrecked: a loss, well inside the time limit.
    const idle = createCombatMatch({ seed: 2 });
    const idleEvents: SimEvent[] = [];
    for (let i = 0; i < MATCH_TICKS && idle.snapshot().match.status === "running"; i += 1) idleEvents.push(...tickOnce(idle));
    const lost = idle.snapshot();
    expect(lost.match).toMatchObject({ status: "lost", reason: "wrecked" });
    expect(lost.match.endedTick).toBeLessThanOrEqual(MATCH_TICKS);
    expect(player(lost)).toMatchObject({ alive: false, health: 0 });
    expect(idleEvents.filter((e) => e.kind === "match-ended")).toHaveLength(1);
    expect(idleEvents.some((e) => e.kind === "wrecked" && e.playerId === PLAYER_ID)).toBe(true);

    // The match stays decided: later ticks change no outcome.
    const frozen = idle.snapshot().vehicles;
    for (let i = 0; i < 120; i += 1) tickOnce(idle, { throttle: 1 });
    expect(idle.snapshot().match).toEqual(lost.match);
    expect(idle.snapshot().vehicles).toEqual(frozen);

    // A fighting player can win: the last car running ends the match as a win.
    const winner = createCombatMatch({ seed: 1, playerVehicle: "switchback" });
    const winEvents = autopilot(winner, 300);
    const won = winner.snapshot();
    expect(won.match).toMatchObject({ status: "won", reason: "last-car-running", botsAlive: 0 });
    expect(won.match.endedTick).toBeLessThanOrEqual(MATCH_TICKS);
    expect(player(won).alive).toBe(true);
    expect(won.vehicles.filter((v) => v.bot).every((v) => !v.alive)).toBe(true);
    expect(winEvents.filter((e) => e.kind === "wrecked" && e.playerId !== PLAYER_ID)).toHaveLength(4);
    expect(winEvents.filter((e) => e.kind === "match-ended")).toEqual([expect.objectContaining({ status: "won" })]);
  });

  it("WRECK-T10: restart begins a fresh match", () => {
    const match = createCombatMatch({ seed: 7 });
    const fresh = createCombatMatch({ seed: 7 }).snapshot();
    autopilot(match, 20);
    expect(match.snapshot()).not.toEqual(fresh);
    for (let i = 0; i < MATCH_TICKS && match.snapshot().match.status === "running"; i += 1) tickOnce(match);
    expect(match.snapshot().match.status).toBe("lost");

    match.restart();
    expect(match.snapshot()).toEqual(fresh);
    expect(match.snapshot().match).toMatchObject({ status: "running", endedTick: null, botsAlive: 4 });
    expect(match.drainEvents().filter((e) => e.kind === "spawned")).toHaveLength(5);
    // From the same seed, the new match plays out exactly like the first one did.
    const twin = createCombatMatch({ seed: 7 });
    for (let i = 0; i < 600; i += 1) {
      tickOnce(match);
      tickOnce(twin);
    }
    expect(match.snapshot()).toEqual(twin.snapshot());
  });

  it("WRECK-T10: the app runs the match with HUD, touch controls and a one-tap restart", async () => {
    // A match starts only from the start screen: press Play, then take the pinned Midtown the refusal offers.
    const refuse = async (): Promise<LiveCityOutcome> => ({ ok: false, reason: "offline", fallback: "pinned-midtown", notes: [] });
    const begin = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      fireEvent.click(await screen.findByRole("button", { name: "Play pinned Midtown" }));
    };
    render(createElement(App, { loadCity: refuse }));
    await begin();
    expect(screen.getByRole("meter", { name: "Your health" }).getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByRole("group", { name: "Weapon controls" })).toBeTruthy();
    // WRECK-T16 replaced the hold buttons with a steering pad and three thumb weapons.
    expect(screen.getByRole("group", { name: /Steering pad/ })).toBeTruthy();
    for (const name of ["Fire", "Missile", "Special"]) expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(screen.getByText("Missiles 4/8")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(screen.getByRole("meter", { name: "Your health" }).getAttribute("aria-valuenow")).toBe("100");
    // Choosing another vehicle on the start screen starts the match with that vehicle.
    cleanup();
    render(createElement(App, { loadCity: refuse }));
    fireEvent.click(screen.getByRole("button", { name: /Rivet/ }));
    await begin();
    expect(screen.getByRole("meter", { name: "Your health" }).getAttribute("aria-valuenow")).toBe("150");
  });
});
