import { readFileSync } from "node:fs";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASSIST_KEY, bindDrivingInput, createDrivingControls, STUCK, type DrivingControls } from "../../src/game/input";
import { TouchControls } from "../../src/game/TouchControls";
import type { GamepadLike } from "../../src/input/controls";
import { IDLE_INTENT, toCommand } from "../../src/input/intent";
import { CONTROLS } from "../../src/input/tuning";
import { parseCity } from "../../src/maps/midtown";
import { createCityMatch, PLAYER_ID } from "../../src/sim/combat";
import { TICK_RATE } from "../../src/sim/contracts";

afterEach(() => {
  cleanup();
  localStorage.clear();
  Reflect.deleteProperty(document, "hidden");
});

const city = parseCity(JSON.parse(readFileSync("public/maps/midtown/city.json", "utf8")));
const FULL = CONTROLS.maxDragPx;

const noPad = (env: Parameters<typeof createDrivingControls>[0] = {}): DrivingControls =>
  createDrivingControls({ getGamepads: () => [], ...env });

const pad = (axes: number[], pressed: Record<number, number> = {}): GamepadLike => ({
  axes,
  buttons: Array.from({ length: 16 }, (_, i) => ({ value: pressed[i] ?? 0, pressed: (pressed[i] ?? 0) > 0.5 })),
});

const setHidden = (hidden: boolean): void => { Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden }); };

describe("WRECK-T2: phone driving controls", () => {
  it("WRECK-T2: pointer cancellation and backgrounding release every held control", () => {
    const controls = noPad();
    const surface = document.createElement("div");
    document.body.append(surface);
    // A stand-in visual viewport and size observer: jsdom has neither.
    const viewport = new EventTarget();
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    let report: (width: number, height: number) => void = () => undefined;
    let observed: Element | null = null;
    let disconnected = false;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: (entries: unknown[]) => void) { report = (width, height) => callback([{ contentRect: { width, height } }]); }
      observe(target: Element) { observed = target; }
      disconnect() { disconnected = true; }
    });
    const released = vi.fn();
    const detach = bindDrivingInput(controls, { surface, onRelease: released });
    render(createElement(TouchControls, { controls }), { container: surface });
    const steering = screen.getByRole("group", { name: /Steering pad/ });
    const button = (name: string) => screen.getByRole("button", { name });

    let next = 10;
    /** Hold a steer, a brake, the gun, a missile and keys, all at once, on fresh pointers. */
    const holdEverything = () => {
      const id = (next += 10);
      fireEvent.pointerDown(steering, { pointerId: id, clientX: 100, clientY: 200 });
      fireEvent.pointerMove(steering, { pointerId: id, clientX: 100 + FULL, clientY: 200 });
      fireEvent.pointerDown(button("Fire"), { pointerId: id + 1 });
      fireEvent.pointerDown(button("Brake"), { pointerId: id + 2 });
      fireEvent.pointerDown(button("Missile"), { pointerId: id + 3 });
      fireEvent.keyDown(window, { key: "w" });
      fireEvent.keyDown(window, { key: "Shift" });
      expect(controls.sample()).toMatchObject({ steer: 1, throttle: 1, fire: true, brake: true, handbrake: true, missile: true });
      return id;
    };
    /** The very next sample is idle, and the release was announced in the same tick. */
    const expectReleased = (why: string, interrupt: () => void) => {
      released.mockClear();
      act(interrupt);
      expect(released, why).toHaveBeenCalled();
      expect(controls.sample(), why).toEqual(IDLE_INTENT);
    };

    // A normal lift releases only its own contact, even though the browser then reports lost capture.
    let id = holdEverything();
    fireEvent.pointerUp(button("Fire"), { pointerId: id + 1 });
    fireEvent.lostPointerCapture(button("Fire"), { pointerId: id + 1 });
    expect(controls.sample()).toMatchObject({ steer: 1, brake: true, fire: false });
    fireEvent.pointerUp(button("Brake"), { pointerId: id + 2 });
    fireEvent.lostPointerCapture(button("Brake"), { pointerId: id + 2 });
    expect(controls.sample()).toMatchObject({ steer: 1, fire: false });
    controls.clear();

    id = holdEverything();
    expectReleased("pointercancel on the pad", () => { fireEvent.pointerCancel(steering, { pointerId: id }); });
    id = holdEverything();
    expectReleased("pointercancel on a button", () => { fireEvent.pointerCancel(button("Fire"), { pointerId: id + 1 }); });
    id = holdEverything();
    expectReleased("capture lost on the pad", () => { fireEvent.lostPointerCapture(steering, { pointerId: id }); });
    id = holdEverything();
    expectReleased("capture lost on the brake", () => { fireEvent.lostPointerCapture(button("Brake"), { pointerId: id + 2 }); });

    const interruptions: [string, () => void][] = [
      ["window blur", () => { fireEvent(window, new Event("blur")); }],
      ["page hidden", () => { setHidden(true); fireEvent(document, new Event("visibilitychange")); setHidden(false); }],
      ["pagehide", () => { fireEvent(window, new Event("pagehide")); }],
      ["cancelled touch", () => { fireEvent(window, new Event("touchcancel")); }],
      ["rotation", () => { fireEvent(window, new Event("orientationchange")); }],
      ["resize that keeps the orientation", () => { fireEvent(window, new Event("resize")); }],
      ["visual viewport resize", () => { viewport.dispatchEvent(new Event("resize")); }],
    ];
    for (const [why, interrupt] of interruptions) {
      holdEverything();
      expectReleased(why, interrupt);
    }

    // A reflow of the controls releases; the observer's first report and an unchanged size do not.
    expect(observed).toBe(surface);
    report(360, 500);
    holdEverything();
    report(360, 500);
    expect(controls.sample()).toMatchObject({ steer: 1, fire: true });
    expectReleased("control reflow", () => report(500, 360));

    // The old finger never reported lifting, yet the pad takes the next one.
    holdEverything();
    act(() => { fireEvent(window, new Event("blur")); });
    fireEvent.pointerDown(steering, { pointerId: 900, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(steering, { pointerId: 900, clientX: 50 - FULL, clientY: 50 });
    expect(controls.sample()).toMatchObject({ steer: -1, throttle: 1, fire: false, brake: false });

    detach();
    expect(disconnected).toBe(true);
    expect(controls.sample()).toEqual(IDLE_INTENT);
    fireEvent.pointerDown(button("Fire"), { pointerId: 901 });
    fireEvent(window, new Event("resize"));
    viewport.dispatchEvent(new Event("resize"));
    expect(controls.sample().fire).toBe(true);

    surface.remove();
    Reflect.deleteProperty(window, "visualViewport");
    vi.unstubAllGlobals();
  });

  it("WRECK-T2: touch keyboard and gamepad feed the same simulation contract", () => {
    // Hard right, full throttle, brake and the gun, from each device.
    const keyboard = noPad();
    for (const key of ["d", "w", "b", " "]) keyboard.key(true, key);
    const gamepad = createDrivingControls({ getGamepads: () => [pad([1, 0], { 7: 1, 3: 1, 0: 1 })] });
    const touch = noPad();
    touch.touch.steerStart(1, 0, 0);
    touch.touch.steerMove(1, FULL, 0);
    touch.touch.press("fire", 2);
    touch.brake(true, 3);

    const commands = [keyboard, gamepad, touch].map((c) => toCommand(c.sample(), 0, PLAYER_ID));
    expect(commands[0]).toMatchObject({ v: 1, steer: 1, brake: true, fire: true });
    // The thumb's automatic throttle yields to the brake; keys and triggers say exactly what is held.
    expect(commands[2]).toEqual({ ...commands[0], throttle: 0 });
    expect(commands[1]).toEqual(commands[0]);
    touch.brake(false, 3);
    keyboard.key(false, "b");
    const driving = [keyboard, createDrivingControls({ getGamepads: () => [pad([1, 0], { 7: 1, 0: 1 })] }), touch];
    const matches = driving.map(() => createCityMatch(city, { seed: 4, bots: 1 }));
    for (let i = 0; i < TICK_RATE; i += 1) {
      driving.forEach((controls, k) => {
        const match = matches[k]!;
        expect(match.submitInput(toCommand(controls.sample(), i, PLAYER_ID))).toEqual({ accepted: true });
        match.advance(1 / TICK_RATE);
        controls.consume();
      });
    }
    expect(matches[1]!.snapshot()).toEqual(matches[0]!.snapshot());
    expect(matches[2]!.snapshot()).toEqual(matches[0]!.snapshot());
    expect(matches[0]!.snapshot().vehicles[0]!.speed).toBeGreaterThan(1);

    // With the assisted accelerator off the car drives only while the steering thumb is down.
    const memory = new Map<string, string>();
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); } };
    const manual = noPad({ storage });
    expect(manual.assist).toBe(true);
    manual.touch.press("fire", 1);
    expect(manual.sample().throttle).toBe(1);
    manual.setAssist(false);
    expect(memory.get(ASSIST_KEY)).toBe("off");
    expect(manual.sample()).toMatchObject({ throttle: 0, fire: true });
    manual.touch.steerStart(2, 0, 0);
    expect(manual.sample().throttle).toBe(1);
    manual.touch.steerEnd(2);
    expect(manual.sample().throttle).toBe(0);
    // Keys are not the assisted accelerator, and the choice survives a reload.
    manual.key(true, "w");
    expect(manual.sample().throttle).toBe(1);
    expect(noPad({ storage }).assist).toBe(false);
    // Storage that throws leaves the assist on and the controls usable.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const blocked = noPad({ storage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } });
    expect(blocked.assist).toBe(true);
    blocked.setAssist(false);
    expect(blocked.assist).toBe(false);
    expect(warned).toHaveBeenCalledTimes(2);
    warned.mockRestore();

    // Stuck: the assisted accelerator backs out after enough slow ticks, then drives on.
    const stuck = noPad({ storage: null });
    stuck.touch.press("fire", 1);
    const at = (tick: number, speed = 0) => stuck.sample(1, { tick, speed });
    for (let tick = 0; tick < STUCK.ticks; tick += 1) expect(at(tick).throttle).toBe(1);
    expect(at(STUCK.ticks)).toMatchObject({ throttle: -1, steer: 1, fire: true });
    expect(at(STUCK.ticks + STUCK.reverseTicks - 1, -5).throttle).toBe(-1);
    expect(at(STUCK.ticks + STUCK.reverseTicks, -5)).toMatchObject({ throttle: 1, steer: 0 });
    // A moving car is never reversed, and a restarted match starts the count again.
    for (let tick = 200; tick < 400; tick += 1) expect(at(tick, 12).throttle).toBe(1);
    for (let tick = 400; tick < 430; tick += 1) at(tick);
    expect(at(0).throttle).toBe(1);
    // A held key or a held brake is the player's own choice: neither is overridden.
    const own = noPad({ storage: null });
    own.key(true, "w");
    for (let tick = 0; tick < 3 * STUCK.ticks; tick += 1) expect(own.sample(1, { tick, speed: 0 }).throttle).toBe(1);
    own.clear();
    own.touch.press("fire", 1);
    own.brake(true, 2);
    for (let tick = 0; tick < 3 * STUCK.ticks; tick += 1) expect(own.sample(1, { tick, speed: 0 }).throttle).toBe(0);

    // In the real city: thumbs off the steering, the car runs into something and gets itself moving backwards.
    const match = createCityMatch(city, { seed: 8, bots: 1, difficulty: "easy" });
    const rider = noPad({ storage: null });
    rider.touch.press("special", 1);
    let slowest = 0;
    for (let i = 0; i < 40 * TICK_RATE && match.snapshot().match.status === "running"; i += 1) {
      const now = match.snapshot();
      const intent = rider.sample(1 / TICK_RATE, { tick: now.tick, speed: now.vehicles[0]!.speed });
      match.submitInput(toCommand(intent, now.tick, PLAYER_ID));
      match.advance(1 / TICK_RATE);
      slowest = Math.min(slowest, match.snapshot().vehicles[0]!.speed);
    }
    expect(slowest).toBeLessThan(-STUCK.speed);
  });

  it("WRECK-T2: phone layout keeps driving controls reachable without hover", () => {
    // Apply the shipped stylesheet as a portrait touch phone sees it: its phone media rules are unwrapped.
    const source = document.createElement("style");
    source.textContent = readFileSync("src/styles.css", "utf8");
    document.head.append(source);
    const all = Array.from(source.sheet!.cssRules);
    const phone = /max-width:\s*600px|pointer:\s*coarse/;
    const applied = all.flatMap((rule) => {
      const media = rule as CSSMediaRule;
      if (!media.media) return [rule.cssText];
      return phone.test(media.media.mediaText) ? Array.from(media.cssRules, (r) => r.cssText) : [];
    });
    source.textContent = applied.join("\n");

    const controls = noPad();
    const view = render(createElement("div", { className: "drive-stage" }, createElement(TouchControls, { controls })));
    const root = view.container;
    const style = (selector: string) => getComputedStyle(root.querySelector(selector)!);
    const pixels = (length: string): number => parseFloat(length) * (length.endsWith("rem") ? 16 : 1);

    // Every control is on screen at once and at least a thumb (44px) in each direction.
    for (const name of ["Brake", "Fire", "Missile", "Special"]) {
      const button = screen.getByRole("button", { name });
      const computed = getComputedStyle(button);
      expect(computed.display, name).not.toBe("none");
      expect(computed.visibility, name).not.toBe("hidden");
      expect(computed.pointerEvents, name).toBe("auto");
      expect(computed.touchAction, name).toBe("none");
      expect(pixels(computed.width), name).toBeGreaterThanOrEqual(64);
      expect(pixels(computed.height), name).toBeGreaterThanOrEqual(64);
    }
    expect(style(".steer-pad").pointerEvents).toBe("auto");
    expect(style(".steer-pad").touchAction).toBe("none");
    expect(style(".assist").pointerEvents).toBe("auto");
    expect(pixels(style(".assist").minHeight)).toBeGreaterThanOrEqual(44);
    // The four buttons have a grid cell each, so none covers another.
    const cells = ["brake", "special", "missile", "fire"].map((n) => `${style(`.action-${n}`).gridColumn}/${style(`.action-${n}`).gridRow}`);
    expect(new Set(cells).size).toBe(4);
    expect(style(".touch-layer").gridTemplateColumns).toContain("auto");

    // Nothing about the controls waits for a mouse to hover over it.
    expect(applied.filter((rule) => rule.includes(":hover"))).toEqual([]);

    // The assisted accelerator is a plain tap, and its state is spoken.
    const toggle = screen.getByRole("button", { name: "Auto gas: on" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Auto gas: off" }).getAttribute("aria-pressed")).toBe("false");
    expect(controls.assist).toBe(false);

    // Taps meant for the resume, results and retry screens are not swallowed by the controls layer.
    const overlays = document.createElement("div");
    overlays.innerHTML = '<div class="resume"></div><div class="results"></div><div class="graphics-fallback"></div>';
    root.append(overlays);
    const layer = Number(style(".touch-layer").zIndex);
    for (const overlay of [".resume", ".results", ".graphics-fallback"]) expect(Number(style(overlay).zIndex), overlay).toBeGreaterThan(layer);
    source.remove();
  });
});
