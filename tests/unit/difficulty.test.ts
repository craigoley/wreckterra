import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createIndexedGeometry, parseCity } from "../../src/maps/midtown";
import type { CityData } from "../../src/maps/city-compiler";
import type { BotCommand } from "../../src/sim/bots";
import { createCityMatch, PLAYER_ID } from "../../src/sim/combat";
import { CONTRACT_VERSION, TICK_RATE, type CombatAuthority } from "../../src/sim/contracts";
import { DEFAULT_MENU_DIFFICULTY, DIFFICULTIES, difficultyRules, type Difficulty } from "../../src/sim/difficulty";

const city: CityData = parseCity(JSON.parse(readFileSync("public/maps/midtown/city.json", "utf8")));
const geometry = createIndexedGeometry(city);
const IDLE: BotCommand = { steer: 0, throttle: 0, brake: false, fire: false, missile: false, special: false };
const LEVELS: Difficulty[] = ["easy", "normal", "hard"];

function tickIdle(match: CombatAuthority): void {
  const s = match.snapshot();
  expect(match.submitInput({ v: CONTRACT_VERSION, tick: s.tick, playerId: PLAYER_ID, ...IDLE })).toEqual({ accepted: true });
  match.advance(1 / TICK_RATE);
}

/** The tick a player who never moves is wrecked on (or the time limit), within a cap that keeps the test fast. */
function stillPlayerEnds(difficulty: Difficulty | undefined, seed: number, capTicks: number): number {
  const match = createCityMatch(city, { seed, difficulty });
  while (match.snapshot().match.status === "running" && match.snapshot().tick < capTicks) tickIdle(match);
  return match.snapshot().tick;
}

describe("WRECK-T18: difficulty levels for the bots", () => {
  it("WRECK-T18: normal difficulty equals today's bot rules", () => {
    expect(difficultyRules("normal")).toEqual({ botDamageScale: 0.45, botSpread: 0.045, botGraceTicks: 240, botGunAlignment: 0.14, botMissileChance: 0.05 });
    expect(difficultyRules()).toEqual(difficultyRules("normal"));
    expect(DIFFICULTIES.map((d) => d.id)).toEqual(LEVELS);
    expect(DEFAULT_MENU_DIFFICULTY).toBe("easy");
    // Omitting the level replays exactly the match that names Normal.
    const trace = (difficulty: Difficulty | undefined) => {
      const match = createCityMatch(city, { seed: 5, difficulty });
      for (let i = 0; i < 600; i += 1) tickIdle(match);
      const s = match.snapshot();
      return JSON.stringify({ vehicles: s.vehicles, missiles: s.missiles, status: s.match.status, level: s.match.difficulty });
    };
    expect(trace(undefined)).toEqual(trace("normal"));
  });

  it("WRECK-T18: difficulty levels are strictly ordered", () => {
    const [easy, normal, hard] = LEVELS.map((level) => difficultyRules(level)) as [ReturnType<typeof difficultyRules>, ReturnType<typeof difficultyRules>, ReturnType<typeof difficultyRules>];
    expect(easy.botDamageScale).toBeLessThan(normal.botDamageScale);
    expect(normal.botDamageScale).toBeLessThan(hard.botDamageScale);
    expect(easy.botMissileChance).toBeLessThan(normal.botMissileChance);
    expect(normal.botMissileChance).toBeLessThan(hard.botMissileChance);
    expect(easy.botGunAlignment).toBeLessThan(normal.botGunAlignment);
    expect(normal.botGunAlignment).toBeLessThan(hard.botGunAlignment);
    expect(easy.botSpread).toBeGreaterThan(normal.botSpread);
    expect(normal.botSpread).toBeGreaterThan(hard.botSpread);
    expect(easy.botGraceTicks).toBeGreaterThan(normal.botGraceTicks);
    expect(normal.botGraceTicks).toBeGreaterThan(hard.botGraceTicks);
  });

  it("WRECK-T18: a still player survives longer on easier levels", () => {
    const seeds = [21, 22, 23];
    const cap = 90 * TICK_RATE;
    const mean = (level: Difficulty) => seeds.reduce((sum, seed) => sum + stillPlayerEnds(level, seed, cap), 0) / seeds.length;
    const [easy, normal, hard] = [mean("easy"), mean("normal"), mean("hard")];
    expect(easy).toBeGreaterThan(normal);
    expect(normal).toBeGreaterThan(hard);
  });

  it("WRECK-T18: bots keep to the streets on every difficulty", () => {
    for (const level of ["easy", "hard"] as const) {
      let on = 0;
      let samples = 0;
      for (const seed of [11, 12, 13]) {
        const match = createCityMatch(city, { seed, difficulty: level });
        for (let i = 0; i < 25 * TICK_RATE && match.snapshot().match.status === "running"; i += 1) {
          tickIdle(match);
          const s = match.snapshot();
          const player = s.vehicles[0]!;
          for (const bot of s.vehicles.filter((v) => v.bot && v.alive)) {
            if (Math.hypot(bot.x - player.x, bot.z - player.z) <= 30) continue;
            samples += 1;
            if (geometry.roadDistance(bot.x, bot.z) < 12) on += 1;
          }
        }
      }
      expect(samples, `${level}: bots travelled`).toBeGreaterThan(200);
      expect(on / samples, `${level}: bots drive the streets`).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("WRECK-T18: a snapshot carries its difficulty and restart keeps it", () => {
    expect(createCityMatch(city, { seed: 1 }).snapshot().match.difficulty).toBe("normal");
    for (const level of LEVELS) {
      const match = createCityMatch(city, { seed: 1, difficulty: level });
      expect(match.snapshot().match.difficulty).toBe(level);
      for (let i = 0; i < 120; i += 1) tickIdle(match);
      match.restart();
      expect(match.snapshot().tick).toBe(0);
      expect(match.snapshot().match.difficulty).toBe(level);
    }
  });
});
