import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chaseRoll, chaseShot } from "../../src/game/ChaseCamera";
import { createControls, dragToSteer, stickToSteer, vibrateOnHit, type Controls, type GamepadLike } from "../../src/input/controls";
import { IDLE_INTENT, toCommand, type InputIntent } from "../../src/input/intent";
import { CAMERA, CONTROLS } from "../../src/input/tuning";
import { parseCity } from "../../src/maps/midtown";
import { createCityMatch, PLAYER_ID } from "../../src/sim/combat";
import { TICK_RATE, type SimEvent } from "../../src/sim/contracts";

const city = parseCity(JSON.parse(readFileSync("public/maps/midtown/city.json", "utf8")));

const pad = (axes: number[], pressed: Record<number, number> = {}): GamepadLike => ({
  axes,
  buttons: Array.from({ length: 16 }, (_, i) => ({ value: pressed[i] ?? 0, pressed: (pressed[i] ?? 0) > 0.5 })),
});
const withPad = (p: GamepadLike): Controls => createControls({ getGamepads: () => [p] });
const noPad = (): Controls => createControls({ getGamepads: () => [] });
const keys = (c: Controls, ...names: string[]) => names.forEach((k) => c.key(true, k));
const FULL = CONTROLS.maxDragPx;

/** One frame of the real loop: sample, submit, advance, and spend the latches only if a tick ran. */
function frame(match: ReturnType<typeof createCityMatch>, controls: Controls, seconds: number): SimEvent[] {
  const intent = controls.sample(seconds);
  match.submitInput(toCommand(intent, match.snapshot().tick, PLAYER_ID));
  if (match.advance(seconds) > 0) controls.consume();
  return match.drainEvents();
}
const launches = (events: SimEvent[]) => events.filter((e) => e.kind === "missile-launched").length;

describe("WRECK-T16: one input intent for every device", () => {
  it("WRECK-T16: every device produces the same intent", () => {
    // Hard right, full throttle, gun and a missile.
    const forward: InputIntent = { ...IDLE_INTENT, steer: 1, throttle: 1, fire: true, missile: true };
    const keyboard = noPad();
    keys(keyboard, "ArrowRight", "ArrowUp", " ", "q");
    const gamepad = withPad(pad([1, 0], { 7: 1, 0: 1, 1: 1 }));
    const touch = noPad();
    touch.touch.steerStart(1, 100, 300);
    touch.touch.steerMove(1, 100 + FULL, 300);
    touch.touch.press("fire", 2);
    touch.touch.press("missile", 3);
    for (const device of [keyboard, gamepad, touch]) expect(device.sample()).toEqual(forward);

    // Hard left, reverse and the special.
    const back: InputIntent = { ...IDLE_INTENT, steer: -1, throttle: -1, special: true };
    const keyboard2 = noPad();
    keys(keyboard2, "a", "s", "e");
    const gamepad2 = withPad(pad([-1, 0], { 6: 1, 2: 1 }));
    const touch2 = noPad();
    touch2.touch.steerStart(1, 200, 100);
    touch2.touch.steerMove(1, 200 - FULL, 100 + CONTROLS.reverseDragPx + 20);
    touch2.touch.press("special", 2);
    for (const device of [keyboard2, gamepad2, touch2]) expect(device.sample()).toEqual(back);

    // Keyboard and gamepad both have a handbrake and a brake; each becomes the contract's single brake.
    const brakes = withPad(pad([0, 0], { 3: 1, 4: 1 }));
    const held = noPad();
    keys(held, "b", "Shift");
    expect(brakes.sample()).toEqual(held.sample());
    expect(toCommand(held.sample(), 7, PLAYER_ID)).toMatchObject({ v: 1, tick: 7, playerId: PLAYER_ID, brake: true });

    // The stick has a radial deadzone, rescaled so the deadzone edge is zero and there is no jump.
    expect(stickToSteer(CONTROLS.stickDeadzone, 0)).toBe(0);
    expect(stickToSteer(0.1, 0.1)).toBe(0);
    expect(stickToSteer(CONTROLS.stickDeadzone + 0.01, 0)).toBeLessThan(0.02);
    expect(stickToSteer(1, 0)).toBe(1);
    expect(stickToSteer(-0.575, 0)).toBeCloseTo(-0.5, 5);

    // Keyboard steering ramps rather than snapping, and a lost focus releases everything.
    const ramp = noPad();
    keys(ramp, "d");
    const first = ramp.sample(1 / 60).steer;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1);
    ramp.clear();
    expect(ramp.sample()).toEqual(IDLE_INTENT);

    // The game reads its controls through the adapter, and every device ends up as the same command.
    expect(toCommand({ ...IDLE_INTENT, steer: 5, throttle: -5 }, 0, PLAYER_ID)).toMatchObject({ steer: 1, throttle: -1 });
  });

  it("WRECK-T16: touch steer ramps from the deadzone edge to full lock", () => {
    const dz = CONTROLS.deadzonePx;
    expect(dragToSteer(0)).toBe(0);
    expect(dragToSteer(dz)).toBe(0);
    expect(dragToSteer(-dz)).toBe(0);
    // Just past the deadzone edge it is barely steering: no step at the boundary.
    expect(dragToSteer(dz + 0.5)).toBeGreaterThan(0);
    expect(dragToSteer(dz + 0.5)).toBeLessThan(0.01);
    // Linear from the edge to full lock, mirrored on the left.
    const mid = dz + (FULL - dz) / 2;
    expect(dragToSteer(mid)).toBeCloseTo(0.5, 6);
    expect(dragToSteer(-mid)).toBeCloseTo(-0.5, 6);
    expect(dragToSteer(FULL)).toBe(1);
    expect(dragToSteer(-FULL)).toBe(-1);
    expect(dragToSteer(FULL * 3)).toBe(1);
    let last = 0;
    for (let px = dz; px <= FULL; px += 1) {
      const steer = dragToSteer(px);
      expect(steer).toBeGreaterThanOrEqual(last);
      expect(steer - last).toBeLessThan(1 / (FULL - dz) + 1e-9);
      last = steer;
    }

    // Through the adapter the drag is measured from where the thumb landed, not from the screen.
    const c = noPad();
    c.touch.steerStart(4, 500, 240);
    c.touch.steerMove(4, 500 + mid, 240);
    expect(c.sample().steer).toBeCloseTo(0.5, 6);
    // Throttle is on by default; a long drag downwards reverses; releasing leaves the car driving.
    expect(c.sample().throttle).toBe(1);
    c.touch.steerMove(4, 500 + mid, 240 + CONTROLS.reverseDragPx + 1);
    expect(c.sample().throttle).toBe(-1);
    c.touch.steerEnd(4);
    expect(c.sample()).toMatchObject({ steer: 0, throttle: 1 });
    // A second finger cannot steal the pad's steering, and a cancelled touch clears everything.
    c.touch.steerStart(5, 0, 0);
    c.touch.steerStart(6, 0, 0);
    c.touch.steerMove(6, FULL, 0);
    expect(c.sample().steer).toBe(0);
    c.touch.steerMove(5, FULL, 0);
    expect(c.sample().steer).toBe(1);
    c.clear();
    expect(c.sample()).toEqual(IDLE_INTENT);
  });

  it("WRECK-T16: a held missile button fires once per press", () => {
    // At 60 Hz, and at 20 Hz where each frame runs three ticks, a held button spends one missile.
    for (const hz of [60, 20]) {
      const match = createCityMatch(city, { seed: 11, bots: 1 });
      const controls = noPad();
      controls.touch.press("missile", 1);
      let fired = 0;
      for (let i = 0; i < 4 * hz; i += 1) fired += launches(frame(match, controls, 1 / hz));
      expect(fired).toBe(1);
      // Released and pressed again, once the launcher has cooled down: exactly one more.
      controls.touch.release("missile", 1);
      for (let i = 0; i < hz; i += 1) fired += launches(frame(match, controls, 1 / hz));
      controls.touch.press("missile", 1);
      for (let i = 0; i < 2 * hz; i += 1) fired += launches(frame(match, controls, 1 / hz));
      expect(fired).toBe(2);
      controls.touch.release("missile", 1);
    }

    // The latch survives a frame that ran no tick, and a keyboard auto-repeat is not a new press.
    const c = noPad();
    c.key(true, "q");
    c.key(true, "q");
    c.key(true, "q");
    expect(c.sample().missile).toBe(true);
    expect(c.sample().missile).toBe(true);
    c.consume();
    expect(c.sample().missile).toBe(false);
    c.key(false, "q");
    c.key(true, "q");
    expect(c.sample().missile).toBe(true);

    // A tap that lands and lifts between two frames still fires, and the gamepad button is edge-triggered too.
    const tap = noPad();
    tap.touch.press("special", 1);
    tap.touch.release("special", 1);
    expect(tap.sample().special).toBe(true);
    const buttons = pad([0, 0], { 1: 1 });
    const gamepad = withPad(buttons);
    expect(gamepad.sample().missile).toBe(true);
    gamepad.consume();
    expect(gamepad.sample().missile).toBe(false);
    expect(TICK_RATE).toBe(60);
  });

  it("WRECK-T16: steering and firing work together on touch", () => {
    const c = noPad();
    c.touch.steerStart(1, 120, 260);
    c.touch.steerMove(1, 120 + FULL, 260);
    c.touch.press("fire", 2);
    expect(c.sample()).toEqual({ ...IDLE_INTENT, steer: 1, throttle: 1, fire: true });
    // A missile with a third finger does not disturb the other two.
    c.touch.press("missile", 3);
    expect(c.sample()).toMatchObject({ steer: 1, fire: true, missile: true });
    c.consume();
    c.touch.release("missile", 3);
    // Lifting the gun finger leaves the steering alone; it is the same intent a real match accepts.
    c.touch.release("fire", 2);
    const intent = c.sample();
    expect(intent).toMatchObject({ steer: 1, fire: false });
    const match = createCityMatch(city, { seed: 3, bots: 1 });
    expect(match.submitInput(toCommand(intent, 0, PLAYER_ID))).toEqual({ accepted: true });

    // Both fingers firing and steering together move the real simulation.
    const driven = noPad();
    driven.touch.steerStart(1, 0, 0);
    driven.touch.steerMove(1, FULL, 0);
    driven.touch.press("fire", 2);
    const before = match.snapshot().vehicles[0]!;
    let shots = 0;
    for (let i = 0; i < TICK_RATE; i += 1) shots += frame(match, driven, 1 / TICK_RATE).filter((e) => e.kind === "shot").length;
    const after = match.snapshot().vehicles[0]!;
    expect(shots).toBeGreaterThan(0);
    expect(after.heading).not.toBe(before.heading);

    // A hit on the player's car buzzes the device where it can; other hits do not.
    const buzzes: number[] = [];
    const hit = (targetId: string): SimEvent => ({ v: 1, tick: 1, kind: "hit", playerId: "bot-1", targetId, weapon: "gun", damage: 1, x: 0, z: 0 });
    expect(vibrateOnHit([hit("bot-1")], PLAYER_ID, (ms) => { buzzes.push(ms); return true; })).toBe(false);
    expect(vibrateOnHit([hit(PLAYER_ID)], PLAYER_ID, (ms) => { buzzes.push(ms); return true; })).toBe(true);
    expect(buzzes).toEqual([CONTROLS.hitVibrationMs]);
  });

  it("WRECK-T16: the chase camera widens with speed and leans into a slide", () => {
    const standing = chaseShot({ x: 0, z: 0, heading: 0, speed: 0 }, 0, 30);
    const flying = chaseShot({ x: 0, z: 0, heading: 0, speed: 30 }, 0, 30);
    expect(standing.fov).toBe(CAMERA.fovNear);
    expect(flying.fov).toBe(CAMERA.fovFar);
    expect(flying.position[2]).toBeLessThan(standing.position[2]);
    // Straight ahead there is no roll; a slide to either side rolls opposite ways, and never past the limit.
    expect(chaseRoll({ x: 0, z: 0, heading: 0, speed: 30 }, 0)).toBe(0);
    const right = chaseRoll({ x: 0, z: 0, heading: -0.5, speed: 20 }, 0);
    const left = chaseRoll({ x: 0, z: 0, heading: 0.5, speed: 20 }, 0);
    expect(right).toBeLessThan(0);
    expect(left).toBeCloseTo(-right, 9);
    expect(Math.abs(chaseRoll({ x: 0, z: 0, heading: 1.5, speed: 500 }, 0))).toBe(CAMERA.maxRoll);
  });
});
