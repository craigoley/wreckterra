import { readFileSync } from "node:fs";
import { createElement, type ReactElement, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CityScene, QUALITY_LEVELS } from "../../src/game/CityScene";
import { parseCity } from "../../src/maps/midtown";
import { createCityMatch, PLAYER_ID } from "../../src/sim/combat";
import { CONTRACT_VERSION, TICK_RATE, type CombatAuthority } from "../../src/sim/contracts";

/** The renderer is stood in for: it keeps what the Canvas was configured with, and frames are cranked by hand. */
const fiber = vi.hoisted(() => ({
  /** The pixel ratio the renderer was left at after each render of the Canvas. */
  ratios: [] as number[],
  shadow: -1,
  frame: null as null | ((state: unknown, delta: number) => void),
}));
vi.mock("@react-three/fiber", async () => {
  const { isValidElement } = await import("react");
  return {
    // As in the library, every render applies the dpr prop, and without one the screen's ratio held to [1, 2].
    // Of the children only the quality governor is mounted, wired to the scene's own state.
    Canvas: ({ dpr = [1, 2], children }: { dpr?: number | [number, number]; children: ReactNode[] }) => {
      const [low, high] = Array.isArray(dpr) ? dpr : [dpr, dpr];
      fiber.ratios.push(Math.min(Math.max(low, window.devicePixelRatio), high));
      const child = (name: string) => children.find((node): node is ReactElement<{ shadowSize?: number }> => isValidElement(node) && typeof node.type === "function" && node.type.name === name);
      fiber.shadow = child("Sun")?.props.shadowSize ?? -1;
      return child("QualityGovernor") ?? null;
    },
    useFrame: (callback: (state: unknown, delta: number) => void) => { fiber.frame = callback; },
    useThree: () => undefined,
  };
});
// The city's painted textures need a 2D canvas, which jsdom does not draw.
vi.mock("../../src/game/cityMaterials", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/game/cityMaterials")>(),
  createCityMaterials: () => ({ dispose: () => undefined }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const city = parseCity(JSON.parse(readFileSync("public/maps/midtown/city.json", "utf8")));

const WARM_UP = 90;
const WINDOW = 60;
const SMOOTH = 1 / 60;
const MIDDLING = 1 / 45;
const SLOW = 1 / 25;

/** The shipped scene on one screen, past its warm-up. A touch screen starts one level lower. */
function shipped(match: CombatAuthority, device: number, touch = false) {
  cleanup();
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: device });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: touch && query === "(pointer: coarse)" }));
  fiber.ratios.length = 0;
  const props = { city, match, bus: { current: { events: [] } }, colors: {}, maxSpeed: 30 };
  const view = render(createElement(CityScene, props));
  const ratio = (): number => fiber.ratios.at(-1)!;
  const frames = (count: number, delta: number) => { for (let i = 0; i < count; i += 1) act(() => fiber.frame!({}, delta)); };
  /** The app redraws its HUD several times a second, which renders the scene and its Canvas again. */
  const redraw = () => { for (let i = 0; i < 3; i += 1) view.rerender(createElement(CityScene, { ...props })); };
  frames(WARM_UP, SMOOTH);
  /** Frames, then HUD redraws; returns the ratio the renderer is left at. */
  const play = (count: number, delta: number): number => { frames(count, delta); redraw(); return ratio(); };
  return { play, ratio, redraw };
}

/** Each change of ratio, in order: a renderer that is reset between decisions shows up here. */
const changes = (ratios: readonly number[]): number[] => ratios.filter((r, i) => r !== ratios[i - 1]);

describe("WRECK-T2: render quality", () => {
  it("WRECK-T2: render resolution stays bounded and quality adapts from sustained frame times", () => {
    const match = createCityMatch(city, { seed: 9, bots: 1 });
    const before = match.snapshot();

    // A few long frames in a window change nothing, wherever they land and however close to slow the rest is.
    for (const baseline of [SMOOTH, MIDDLING, 1 / 39]) {
      for (const spikes of [1, 3]) {
        const q = shipped(match, 4);
        // A 4x screen is capped at 2x before the level's own scale.
        expect(q.ratio()).toBe(2);
        for (const at of [0, 30, WINDOW - spikes]) {
          q.play(at, baseline);
          q.play(spikes, 3);
          q.play(WINDOW - spikes - at, baseline);
        }
        expect(Math.min(...fiber.ratios)).toBe(2);
      }
    }

    // A touch screen: the level's ratio survives every redraw, from the first render and after each step.
    const phone = shipped(match, 3, true);
    phone.redraw();
    expect(changes(fiber.ratios)).toEqual([1.5]);
    expect(phone.play(WINDOW, SLOW)).toBe(1.1);
    expect(phone.play(WINDOW * 3, SMOOTH)).toBe(1.5);
    expect(changes(fiber.ratios)).toEqual([1.5, 1.1, 1.5]);

    // Sustained slow frames step down one level per full window, never part-way through one.
    const q = shipped(match, 4);
    expect(q.play(WINDOW - 1, SLOW)).toBe(2);
    expect(q.play(1, SLOW)).toBe(1.5);
    expect(q.play(WINDOW, SLOW)).toBe(1.1);
    expect(fiber.shadow).toBe(QUALITY_LEVELS[0]!.shadow);
    expect(q.play(WINDOW * 5, SLOW)).toBe(1.1);
    // Hysteresis: recovery takes three good windows in a row, and a middling one starts the count again.
    q.play(WINDOW * 2, SMOOTH);
    q.play(WINDOW, MIDDLING);
    expect(q.play(WINDOW * 2, SMOOTH)).toBe(1.1);
    expect(q.play(WINDOW, SMOOTH)).toBe(1.5);
    expect(q.play(WINDOW * 30, SMOOTH)).toBe(2.5);
    expect(fiber.shadow).toBe(QUALITY_LEVELS.at(-1)!.shadow);
    // Middling frames hold the level either way.
    expect(q.play(WINDOW * 5, MIDDLING)).toBe(2.5);
    expect(changes(fiber.ratios)).toEqual([2, 1.5, 1.1, 1.5, 2, 2.5]);

    // Resolution is bounded on every screen at every level, redraws included.
    for (const device of [0.5, 1, 3, 8]) {
      const at = shipped(match, device);
      for (const [count, delta] of [[2, SLOW], [9, SMOOTH]] as const) {
        for (let i = 0; i < count; i += 1) at.play(WINDOW, delta);
      }
      expect(Math.min(...fiber.ratios)).toBeGreaterThanOrEqual(0.5);
      expect(Math.max(...fiber.ratios)).toBeLessThanOrEqual(2 * 1.25);
      expect(at.ratio()).toBe(Math.max(0.5, Math.min(device, 2) * 1.25));
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
  }, 60_000);
});
