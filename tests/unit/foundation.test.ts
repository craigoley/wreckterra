import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createElement, StrictMode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "../../src/App";
import { CONTRACT_VERSION, MAX_STEPS_PER_ADVANCE, TICK_RATE } from "../../src/sim/contracts";
import { activeLoopCount, createWorld, startLoop, type FrameScheduler } from "../../src/sim/world";

afterEach(cleanup);

const drive = { v: CONTRACT_VERSION, tick: 0, playerId: "player-1", steer: 0.5, throttle: 1, brake: false };

function run(seed: number, seconds: number) {
  const world = createWorld({ seed });
  expect(world.submitInput(drive)).toEqual({ accepted: true });
  for (let i = 0; i < seconds * TICK_RATE; i += 1) world.advance(1 / TICK_RATE);
  return world;
}

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

describe("WRECK-T1: simulation contract", () => {
  it("WRECK-T1: the simulation advances fixed ticks independently of React", () => {
    const world = createWorld({ seed: 7 });
    expect(world.snapshot()).toMatchObject({ v: CONTRACT_VERSION, tick: 0, seed: 7 });

    for (let i = 0; i < TICK_RATE; i += 1) expect(world.advance(1 / TICK_RATE)).toBe(1);
    expect(world.snapshot().tick).toBe(TICK_RATE);
    // A partial tick is carried over, never rounded into an extra step.
    expect(world.advance(0.01)).toBe(0);
    expect(world.advance(0.01)).toBe(1);
    expect(world.snapshot().tick).toBe(TICK_RATE + 1);
    // A long stall is bounded rather than replayed as a catch-up burst.
    expect(world.advance(30)).toBe(MAX_STEPS_PER_ADVANCE);
    expect(world.advance(0)).toBe(0);
    expect(world.advance(Number.NaN)).toBe(0);

    // Same seed and inputs reproduce the exact state; a different seed changes the arena.
    const a = run(11, 3);
    const b = run(11, 3);
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(a.layout).toEqual(b.layout);
    expect(a.snapshot().vehicles[0].speed).toBeGreaterThan(1);
    expect(run(12, 3).layout).not.toEqual(a.layout);

    // Inputs are validated against the versioned contract.
    expect(world.submitInput({ ...drive, v: 2 })).toEqual({ accepted: false, reason: "bad-version" });
    expect(world.submitInput({ ...drive, steer: 4 })).toEqual({ accepted: false, reason: "out-of-range" });
    expect(world.submitInput({ ...drive, playerId: "someone-else" })).toEqual({ accepted: false, reason: "unknown-player" });
    expect(world.submitInput(null)).toEqual({ accepted: false, reason: "bad-shape" });

    // The vehicle can never leave the arena and a wall hit is reported as an event.
    const rammer = createWorld({ seed: 3 });
    rammer.submitInput({ ...drive, steer: 0 });
    for (let i = 0; i < 20 * TICK_RATE; i += 1) rammer.advance(1 / TICK_RATE);
    const car = rammer.snapshot().vehicles[0];
    expect(Math.abs(car.x)).toBeLessThanOrEqual(rammer.layout.halfExtent);
    expect(Math.abs(car.z)).toBeLessThanOrEqual(rammer.layout.halfExtent);
    expect(rammer.drainEvents().some((event) => event.kind === "impact")).toBe(true);
    expect(rammer.drainEvents()).toEqual([]);
  });

  it("WRECK-T1: foundation commands run real tests and reject a seeded failure", () => {
    const scripts = (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    for (const name of ["typecheck", "test", "test:coverage", "build"]) expect(scripts[name]).toBeTruthy();
    expect(scripts.test).not.toMatch(/passWithNoTests|--bail=0/);

    const vitest = resolve("node_modules/vitest/vitest.mjs");
    const dir = mkdtempSync(join(tmpdir(), "wreckterra-seeded-"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && key !== "NODE_V8_COVERAGE"));
    const runVitest = () => {
      const outputFile = join(dir, "report.json");
      rmSync(outputFile, { force: true });
      const result = spawnSync(process.execPath, [vitest, "run", "--root", dir, "--reporter=json", `--outputFile=${outputFile}`, "--maxWorkers=1"], { cwd: dir, env, encoding: "utf8", timeout: 90_000 });
      let summary: { numTotalTests: number; numFailedTests: number; numPassedTests: number } | undefined;
      try { summary = JSON.parse(readFileSync(outputFile, "utf8")); } catch { summary = undefined; /* no report: vitest refused to run */ }
      return { status: result.status, summary };
    };
    try {
      writeFileSync(join(dir, "vitest.config.mjs"), 'export default { test: { globals: true, include: ["*.test.js"], passWithNoTests: false } };\n');
      // Empty selection must fail rather than pass vacuously.
      expect(runVitest().status).not.toBe(0);

      writeFileSync(join(dir, "good.test.js"), 'test("passes", () => { expect(1 + 1).toBe(2); });\n');
      const good = runVitest();
      expect(good.status).toBe(0);
      expect(good.summary?.numTotalTests).toBe(1);
      expect(good.summary?.numPassedTests).toBe(1);

      writeFileSync(join(dir, "seeded.test.js"), 'test("seeded failure", () => { expect(1 + 1).toBe(3); });\n');
      const bad = runVitest();
      expect(bad.status).not.toBe(0);
      expect(bad.summary?.numTotalTests).toBe(2);
      expect(bad.summary?.numFailedTests).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("WRECK-T1: mount and unmount leave exactly one simulation loop", () => {
    const baseline = activeLoopCount();
    const first = render(createElement(StrictMode, null, createElement(App)));
    // StrictMode mounts, unmounts and remounts effects: exactly one loop may remain.
    expect(activeLoopCount()).toBe(baseline + 1);
    first.unmount();
    expect(activeLoopCount()).toBe(baseline);
    const second = render(createElement(App));
    expect(activeLoopCount()).toBe(baseline + 1);
    second.unmount();
    expect(activeLoopCount()).toBe(baseline);

    // The loop primitive itself: stop is idempotent, pause cancels the frame, resume does not replay.
    const { scheduler, flush, size } = manualScheduler();
    const world = createWorld({ seed: 1 });
    const loop = startLoop(world, { scheduler });
    expect(activeLoopCount()).toBe(baseline + 1);
    flush(0);
    flush(1000 / 60);
    expect(world.snapshot().tick).toBe(1);
    loop.pause();
    expect(size()).toBe(0);
    loop.resume();
    flush(60_000);
    flush(60_000 + 1000 / 60);
    expect(world.snapshot().tick).toBe(2);
    loop.stop();
    loop.stop();
    expect(size()).toBe(0);
    expect(activeLoopCount()).toBe(baseline);
  });
});
