import { readFileSync } from "node:fs";
import { createElement, StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import { createDrivingControls } from "../../src/game/input";
import { bindPageLifecycle, CONTEXT_RESTORE_TIMEOUT_MS, createAudioPort, type LifecycleState } from "../../src/game/lifecycle";
import { bindMatchRuntime } from "../../src/game/VehicleScene";
import { parseCity } from "../../src/maps/midtown";
import type { LiveCityOutcome } from "../../src/maps/tile-city";
import * as combat from "../../src/sim/combat";
import { TICK_RATE, type CombatAuthority } from "../../src/sim/contracts";
import { startLoop, type FrameScheduler } from "../../src/sim/world";

/** The 3D scene is replaced by a bare canvas: jsdom cannot draw, but it can lose and restore a context. */
const drawn: CombatAuthority[] = [];
vi.mock("../../src/game/CityScene", () => ({
  CityScene: ({ match }: { match: CombatAuthority }) => {
    drawn.push(match);
    return createElement("canvas", { "data-testid": "city-canvas" });
  },
}));
vi.mock("../../src/sim/combat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sim/combat")>();
  return { ...actual, createCityMatch: vi.fn(actual.createCityMatch) };
});

const city = parseCity(JSON.parse(readFileSync("public/maps/midtown/city.json", "utf8")));
const setHidden = (hidden: boolean): void => { Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden }); };
const visibility = (hidden: boolean): void => { setHidden(hidden); fireEvent(document, new Event("visibilitychange")); };

afterEach(() => {
  cleanup();
  drawn.length = 0;
  Reflect.deleteProperty(document, "hidden");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function manualScheduler() {
  const pending = new Map<number, (timeMs: number) => void>();
  let next = 1;
  const scheduler: FrameScheduler = {
    request: (cb) => { pending.set(next, cb); return next++; },
    cancel: (handle) => { pending.delete(handle); },
  };
  const flush = (timeMs: number) => { const batch = [...pending.values()]; pending.clear(); batch.forEach((cb) => cb(timeMs)); };
  return { scheduler, flush, size: () => pending.size };
}

const FRAME = 1000 / TICK_RATE;

/** Stands in for the browser's Web Audio context, which jsdom lacks, and records every one built. */
function stubAudioContext(name = "AudioContext") {
  const built: { suspend: unknown; resume: unknown; close: unknown }[] = [];
  vi.stubGlobal(name, class {
    suspend = vi.fn(async () => undefined);
    resume = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    constructor() { built.push(this); }
  });
  return built;
}

/** The runtime exactly as the app binds it: nothing about audio is handed in by the test. */
function checkRuntimeAudio(): void {
  const built = stubAudioContext();
  const match = combat.createCityMatch(city, { seed: 21, bots: 1 });
  const loop = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), running: true };
  const runtime = bindMatchRuntime({ controls: createDrivingControls({ getGamepads: () => [] }), match, loop, surface: null, onChange: () => undefined });
  // Neither hiding, coming back, nor a refused resume builds audio: only an accepted gesture does.
  visibility(true);
  expect(runtime.resume()).toBe(false);
  visibility(false);
  expect(built).toHaveLength(0);
  expect(runtime.resume()).toBe(true);
  expect(built).toHaveLength(1);
  const audio = built[0]!;
  expect(audio.resume).toHaveBeenCalledTimes(1);
  // Every interruption suspends it, and coming back never starts it.
  const interruptions = [() => visibility(true), () => { fireEvent(window, new Event("pagehide")); }, () => runtime.rendererFailed()];
  interruptions.forEach((interrupt, i) => {
    interrupt();
    expect(audio.suspend).toHaveBeenCalledTimes(i + 1);
    visibility(false);
    runtime.retry();
    expect(audio.resume).toHaveBeenCalledTimes(i + 1);
    expect(runtime.resume()).toBe(true);
    expect(audio.resume).toHaveBeenCalledTimes(i + 2);
  });
  // A restart during play is a gesture too, and one context serves the whole match.
  expect(runtime.resume()).toBe(true);
  expect(audio.resume).toHaveBeenCalledTimes(interruptions.length + 2);
  expect(built).toHaveLength(1);
  runtime.dispose();
  expect(audio.close).toHaveBeenCalledTimes(1);
  expect(runtime.resume()).toBe(false);

  // The prefixed constructor is used where it is the only one, and a closed port stays closed.
  vi.stubGlobal("AudioContext", undefined);
  const prefixed = stubAudioContext("webkitAudioContext");
  const port = createAudioPort();
  port.resume();
  port.close();
  port.resume();
  expect(prefixed).toHaveLength(1);
  expect(prefixed[0]!.close).toHaveBeenCalledTimes(1);

  // No Web Audio, or a browser that refuses it, never stops the match.
  vi.stubGlobal("webkitAudioContext", undefined);
  const silent = createAudioPort();
  expect(() => { silent.resume(); silent.suspend(); silent.close(); }).not.toThrow();
  const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  expect(() => createAudioPort(() => { throw new Error("blocked"); }).resume()).not.toThrow();
  expect(warned).toHaveBeenCalledTimes(1);
  warned.mockRestore();
  vi.unstubAllGlobals();
}

/** One real match on a hand-cranked loop, bound to this page. */
function harness() {
  const match = combat.createCityMatch(city, { seed: 21, bots: 1 });
  const frames = manualScheduler();
  const ticks: number[] = [];
  const loop = startLoop(match, { scheduler: frames.scheduler, onFrame: (_, n) => ticks.push(n) });
  const surface = document.createElement("div");
  const audio = { suspend: vi.fn(), resume: vi.fn() };
  const states: LifecycleState[] = [];
  const onPause = vi.fn();
  let waiting: { callback: () => void; ms: number } | null = null;
  const timers = {
    set: (callback: () => void, ms: number) => { waiting = { callback, ms }; return waiting; },
    clear: (handle: unknown) => { if (handle === waiting) waiting = null; },
  };
  const page = bindPageLifecycle({ loop, surface, audio, timers, onPause, onChange: (s) => states.push(s) });
  let now = 0;
  const play = (count: number) => { for (let i = 0; i < count; i += 1) { frames.flush(now); now += FRAME; } };
  return {
    match, loop, frames, ticks, surface, audio, states, onPause, page, play,
    wait: () => waiting,
    away: (ms: number) => { now += ms; },
    canvas: () => { const c = document.createElement("canvas"); surface.append(c); return c; },
    done: () => { page.dispose(); loop.stop(); },
  };
}

const lose = (canvas: Element): Event => {
  const event = new Event("webglcontextlost", { cancelable: true });
  canvas.dispatchEvent(event);
  return event;
};

describe("WRECK-T2: solo page lifecycle", () => {
  it("WRECK-T2: hidden pages pause and tap resume runs no catch-up burst", () => {
    const h = harness();
    h.play(31);
    expect(h.match.snapshot().tick).toBeGreaterThanOrEqual(29);
    expect(h.page.state()).toEqual({ paused: false, graphics: "ok", renderer: 0 });
    expect(h.audio.resume).not.toHaveBeenCalled();

    for (const hide of [() => visibility(true), () => { fireEvent(window, new Event("pagehide")); }]) {
      const before = h.match.snapshot();
      h.audio.suspend.mockClear();
      h.audio.resume.mockClear();
      h.onPause.mockClear();
      hide();
      expect(h.page.state().paused).toBe(true);
      expect(h.audio.suspend).toHaveBeenCalledTimes(1);
      expect(h.onPause).toHaveBeenCalledTimes(1);
      expect(h.frames.size()).toBe(0);
      // A minute away: no frame is scheduled and no tick runs.
      h.away(60_000);
      h.play(5);
      expect(h.match.snapshot()).toEqual(before);
      if (document.hidden) expect(h.page.resume()).toBe(false);
      // Coming back does not resume by itself, and never starts the audio.
      visibility(false);
      expect(h.page.state().paused).toBe(true);
      expect(h.frames.size()).toBe(0);
      expect(h.audio.resume).not.toHaveBeenCalled();
      // The tap does. The first frame runs at most one tick, and the next only its own frame's worth.
      expect(h.page.resume()).toBe(true);
      expect(h.audio.resume).toHaveBeenCalledTimes(1);
      h.ticks.length = 0;
      h.play(1);
      expect(h.ticks[0]).toBeLessThanOrEqual(1);
      h.play(10);
      expect(Math.max(...h.ticks)).toBeLessThanOrEqual(1);
      expect(h.match.snapshot().tick - before.tick).toBeLessThanOrEqual(11);
      expect(h.match.snapshot().tick).toBeGreaterThan(before.tick);
    }

    // A lost context: the browser is asked to give it back, and the match holds meanwhile.
    const canvas = h.canvas();
    const held = h.match.snapshot();
    expect(lose(canvas).defaultPrevented).toBe(true);
    expect(h.page.state()).toEqual({ paused: true, graphics: "lost", renderer: 0 });
    expect(h.wait()?.ms).toBe(CONTEXT_RESTORE_TIMEOUT_MS);
    expect(h.page.resume()).toBe(false);
    // The view may take the canvas away while it recovers; the restore is still heard.
    canvas.remove();
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(h.wait()).toBeNull();
    expect(h.page.state()).toEqual({ paused: true, graphics: "ok", renderer: 0 });
    h.away(10_000);
    h.play(3);
    expect(h.match.snapshot()).toEqual(held);
    expect(h.page.resume()).toBe(true);
    h.play(1);
    expect(h.match.snapshot()).toEqual(held);

    // No restore in time: a retry is offered, then a fresh renderer over the same match.
    lose(h.canvas());
    const stranded = h.match.snapshot();
    h.page.retry();
    expect(h.page.state().renderer).toBe(0);
    h.wait()!.callback();
    expect(h.page.state()).toEqual({ paused: true, graphics: "unavailable", renderer: 0 });
    expect(h.page.resume()).toBe(false);
    h.page.retry();
    expect(h.page.state()).toEqual({ paused: true, graphics: "ok", renderer: 1 });
    expect(h.page.resume()).toBe(true);
    expect(h.match.snapshot()).toEqual(stranded);
    // A view that cannot be built at all is the same recoverable state.
    h.page.rendererFailed();
    h.page.rendererFailed();
    expect(h.page.state()).toEqual({ paused: true, graphics: "unavailable", renderer: 1 });
    expect(h.states.at(-1)).toEqual(h.page.state());

    h.done();
    const count = h.states.length;
    visibility(true);
    lose(h.canvas());
    expect(h.states).toHaveLength(count);

    // A match that starts in a background tab starts paused; the real timer drives the fallback.
    const background = harness();
    expect(background.page.state().paused).toBe(true);
    expect(background.frames.size()).toBe(0);
    background.done();
    setHidden(false);
    checkRuntimeAudio();
    vi.useFakeTimers();
    const surface = document.createElement("div");
    const canvas2 = document.createElement("canvas");
    surface.append(canvas2);
    const rejected = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const real = bindPageLifecycle({ loop: { pause: vi.fn(), resume: vi.fn() }, surface, audio: { suspend: () => Promise.reject(new Error("no audio")), resume: vi.fn() } });
    lose(canvas2);
    vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS - 1);
    expect(real.state().graphics).toBe("lost");
    vi.advanceTimersByTime(1);
    expect(real.state().graphics).toBe("unavailable");
    real.dispose();
    return Promise.resolve().then(() => Promise.resolve()).then(() => { expect(rejected).toHaveBeenCalled(); });
  }, 30_000);

  it("WRECK-T2: the running app holds the match through hiding, context loss and a retry", async () => {
    const realTimeout = globalThis.setTimeout;
    vi.useFakeTimers();
    vi.stubGlobal("WebGL2RenderingContext", class {});
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ getExtension: () => null } as never);
    const audio = stubAudioContext();
    const create = vi.mocked(combat.createCityMatch);
    create.mockClear();
    const refuse = async (): Promise<LiveCityOutcome> => ({ ok: false, reason: "offline", fallback: "pinned-midtown", notes: [] });
    const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const run = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    render(createElement(StrictMode, null, createElement(App, { loadCity: refuse })));
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Play pinned Midtown" }));
    const resume = () => screen.queryByRole("button", { name: "Paused — tap to resume" });
    const canvas = () => screen.getByTestId("city-canvas");
    // React reveals a lazy view on the real clock, which advancing fake time does not move.
    const canvasShown = async () => {
      await vi.dynamicImportSettled();
      for (let tries = 0; tries < 100 && !screen.queryByTestId("city-canvas"); tries += 1) {
        await new Promise<void>((done) => { realTimeout(() => done(), 50); });
        await settle();
      }
      return canvas();
    };
    await canvasShown();
    const match = create.mock.results.at(-1)!.value as CombatAuthority;
    const matches = create.mock.calls.length;
    await run(500);
    expect(match.snapshot().tick).toBeGreaterThan(10);

    // Hidden: held fire is released, nothing ticks, and only the tap resumes.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Fire" }), { pointerId: 1 });
    const submit = vi.spyOn(match, "submitInput");
    act(() => visibility(true));
    expect(submit.mock.calls.at(-1)![0]).toMatchObject({ fire: false, throttle: 0, steer: 0 });
    const hiddenAt = match.snapshot().tick;
    await run(30_000);
    act(() => visibility(false));
    await run(1_000);
    expect(match.snapshot().tick).toBe(hiddenAt);
    expect(audio).toHaveLength(0);
    fireEvent.click(resume()!);
    expect(resume()).toBeNull();
    expect(audio).toHaveLength(1);
    expect(audio[0]!.resume).toHaveBeenCalledTimes(1);
    await run(100);
    expect(match.snapshot().tick - hiddenAt).toBeGreaterThan(0);
    expect(match.snapshot().tick - hiddenAt).toBeLessThanOrEqual(7);

    // Context lost and restored: the same match carries on after a tap.
    const first = canvas();
    act(() => { lose(first); });
    expect(audio[0]!.suspend).toHaveBeenCalledTimes(1);
    const lostAt = match.snapshot().tick;
    expect(resume()).toBeNull();
    await run(1_000);
    act(() => { first.dispatchEvent(new Event("webglcontextrestored")); });
    expect(match.snapshot().tick).toBe(lostAt);
    fireEvent.click(resume()!);
    await run(200);
    expect(match.snapshot().tick).toBeGreaterThan(lostAt);

    // Never restored: an accessible retry builds a fresh canvas over the same match.
    const second = canvas();
    act(() => { lose(second); });
    const strandedAt = match.snapshot().tick;
    await run(CONTEXT_RESTORE_TIMEOUT_MS);
    expect(screen.getByRole("alertdialog", { name: "The 3D view is not available" })).toBeTruthy();
    expect(resume()).toBeNull();
    // Restart is a tap too, but it cannot run a match nobody can see.
    fireEvent.click(screen.getByRole("button", { name: "Retry the 3D view" }));
    expect(await canvasShown()).not.toBe(second);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(drawn.at(-1)).toBe(match);
    expect(match.snapshot().tick).toBe(strandedAt);
    expect(create.mock.calls.length).toBe(matches);
    fireEvent.click(resume()!);
    await run(200);
    expect(match.snapshot().tick).toBeGreaterThan(strandedAt);

    // No context to be had at all: the fallback shows, the match is held, and retry asks again.
    cleanup();
    expect(audio[0]!.close).toHaveBeenCalledTimes(1);
    context.mockReturnValue(null);
    render(createElement(App, { loadCity: refuse }));
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Play pinned Midtown" }));
    await settle();
    const dry = create.mock.results.at(-1)!.value as CombatAuthority;
    await run(1_000);
    expect(screen.getByRole("alertdialog").textContent).toContain("Your match is paused and kept");
    expect(dry.snapshot().tick).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await run(500);
    expect(dry.snapshot().tick).toBe(0);
    expect(audio).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry the 3D view" }));
    await settle();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    context.mockReturnValue({ getExtension: () => null } as never);
    fireEvent.click(screen.getByRole("button", { name: "Retry the 3D view" }));
    expect(await canvasShown()).toBeTruthy();
    expect(dry.snapshot().tick).toBe(0);
    fireEvent.click(resume()!);
    await run(200);
    expect(dry.snapshot().tick).toBeGreaterThan(0);
  }, 30_000);
});
