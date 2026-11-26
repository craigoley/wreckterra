import { readFileSync } from "node:fs";
import { createElement, isValidElement, useState, type ComponentType, type ReactElement, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CityScene, QUALITY_LEVELS } from "../../src/game/CityScene";
import { parseCity } from "../../src/maps/midtown";
import { createCityMatch, PLAYER_ID } from "../../src/sim/combat";
import { CONTRACT_VERSION, TICK_RATE, type CombatAuthority } from "../../src/sim/contracts";

/** The renderer is stood in for: the Canvas hands over its children, and frames are cranked by hand. */
const fiber = vi.hoisted(() => ({
  children: [] as unknown[],
  frame: null as null | ((state: unknown, delta: number) => void),
  setDpr: null as null | ((dpr: number) => void),
}));
vi.mock("@react-three/fiber", () => ({
  Canvas: (props: { children: unknown[] }) => { fiber.children = props.children; return null; },
  useFrame: (callback: (state: unknown, delta: number) => void) => { fiber.frame = callback; },
  useThree: (select: (state: unknown) => unknown) => select({ setDpr: fiber.setDpr }),
}));
// The city's painted textures need a 2D canvas, which jsdom does not draw.
vi.mock("../../src/game/cityMaterials", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/game/cityMaterials")>(),
  createCityMaterials: () => ({ dispose: () => undefined }),
}));

afterEach(cleanup);

const city = parseCity(JSON.parse(readFileSync("public/maps/midtown/city.json", "utf8")));

type Governor = ComponentType<{ level: number; onLevel: (level: number) => void }>;

/** The quality governor exactly as the shipped scene mounts it. */
function shippedGovernor(match: CombatAuthority): Governor {
  render(createElement(CityScene, { city, match, bus: { current: { events: [] } }, colors: {}, maxSpeed: 30 }));
  const found = fiber.children.find((child): child is ReactElement => isValidElement(child) && typeof child.type === "function" && child.type.name === "QualityGovernor");
  expect(found, "the scene mounts a quality governor").toBeTruthy();
  cleanup();
  return found!.type as Governor;
}

const WARM_UP = 90;
const WINDOW = 60;
const SMOOTH = 1 / 60;
const SLOW = 1 / 25;

function drive(match: CombatAuthority, device: number, start: number) {
  const Governor = shippedGovernor(match);
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: device });
  const ratios: number[] = [];
  const levels: number[] = [start];
  fiber.setDpr = (dpr) => { ratios.push(dpr); };
  function Harness(): ReactNode {
    const [level, setLevel] = useState(start);
    return createElement(Governor, { level, onLevel: (next: number) => { levels.push(next); setLevel(next); } });
  }
  render(createElement(Harness));
  const frames = (count: number, delta: number) => { for (let i = 0; i < count; i += 1) act(() => fiber.frame!({}, delta)); };
  frames(WARM_UP, SMOOTH);
  return { ratios, levels, frames, level: () => levels.at(-1)! };
}

describe("WRECK-T2: render quality", () => {
  it("WRECK-T2: render resolution stays bounded and quality adapts from sustained frame times", () => {
    const match = createCityMatch(city, { seed: 9, bots: 1 });
    const before = match.snapshot();
    const q = drive(match, 4, 2);
    // A 4x screen is capped at 2x before the level's own scale.
    expect(q.ratios).toEqual([2]);

    // One enormous spike inside an otherwise smooth window changes nothing, wherever it lands.
    for (const at of [0, 30, WINDOW - 1]) {
      q.frames(at, SMOOTH);
      q.frames(1, 3);
      q.frames(WINDOW - 1 - at, SMOOTH);
    }
    expect(q.levels.filter((level) => level < 2)).toEqual([]);

    // Sustained slow frames step down one level per full window, never part-way through one.
    const q2 = drive(match, 4, 2);
    q2.frames(WINDOW - 1, SLOW);
    expect(q2.level()).toBe(2);
    q2.frames(1, SLOW);
    expect(q2.level()).toBe(1);
    q2.frames(WINDOW, SLOW);
    expect(q2.level()).toBe(0);
    q2.frames(WINDOW * 5, SLOW);
    expect(q2.level()).toBe(0);
    // Hysteresis: recovery takes three good windows in a row, and a middling one starts the count again.
    q2.frames(WINDOW * 2, SMOOTH);
    q2.frames(WINDOW, 1 / 45);
    q2.frames(WINDOW * 2, SMOOTH);
    expect(q2.level()).toBe(0);
    q2.frames(WINDOW, SMOOTH);
    expect(q2.level()).toBe(1);
    q2.frames(WINDOW * 30, SMOOTH);
    expect(q2.level()).toBe(QUALITY_LEVELS.length - 1);
    // Middling frames hold the level either way.
    q2.frames(WINDOW * 5, 1 / 45);
    expect(q2.level()).toBe(QUALITY_LEVELS.length - 1);
    expect(q2.levels).toEqual([2, 1, 0, 1, 2, 3]);

    // Resolution is bounded on every screen at every level.
    for (const device of [0.5, 1, 3, 8]) {
      for (let level = 0; level < QUALITY_LEVELS.length; level += 1) {
        const at = drive(match, device, level);
        expect(at.ratios[0]).toBeGreaterThanOrEqual(0.5);
        expect(at.ratios[0]).toBeLessThanOrEqual(2 * 1.25);
        cleanup();
      }
    }

    // A level is only resolution and shadow detail; the governor never moves the match.
    for (const level of QUALITY_LEVELS) expect(Object.keys(level).sort()).toEqual(["scale", "shadow"]);
    expect(match.snapshot()).toEqual(before);
    // The simulation's fixed tick gives the same world whether the screen draws at 60 or 20 frames a second.
    const smooth = createCityMatch(city, { seed: 9, bots: 2 });
    const slow = createCityMatch(city, { seed: 9, bots: 2 });
    for (const m of [smooth, slow]) m.submitInput({ v: CONTRACT_VERSION, tick: 0, playerId: PLAYER_ID, steer: 0.2, throttle: 1, brake: false, fire: true });
    for (let i = 0; i < 4 * TICK_RATE; i += 1) smooth.advance(1 / TICK_RATE);
    for (let i = 0; i < 4 * 20; i += 1) slow.advance(1 / 20);
    expect(slow.snapshot()).toEqual(smooth.snapshot());
  });
});
