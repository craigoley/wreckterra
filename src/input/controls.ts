import type { SimEvent } from "../sim/contracts";
import { clampUnit, IDLE_INTENT, type InputIntent } from "./intent";
import { CONTROLS } from "./tuning";

export type TouchButton = "fire" | "missile" | "special";

/** The on-screen controls' side of the adapter: pointer positions in, nothing about the screen out. */
export interface TouchInput {
  /** A finger lands on the steering pad; this point is the origin the drag is measured from. */
  steerStart(id: number, x: number, y: number): void;
  steerMove(id: number, x: number, y: number): void;
  steerEnd(id: number): void;
  press(button: TouchButton, id: number): void;
  release(button: TouchButton, id: number): void;
}

export interface Controls {
  /** The merged intent from every device. Pass the seconds since the last call so keyboard steering can ramp. */
  sample(dtSeconds?: number): InputIntent;
  /** The simulation ran a tick on the intent just sampled: spend the one-shot latches. */
  consume(): void;
  /** Release everything: a lost focus, a hidden page or a cancelled touch must never leave a control stuck. */
  clear(): void;
  /** A keyboard key went down or up. Returns true when the key is a game control. */
  key(down: boolean, key: string): boolean;
  readonly touch: TouchInput;
  /** Listen to the keyboard and to focus, visibility and layout changes. Returns the function that stops listening. */
  attach(): () => void;
}

export interface GamepadLike {
  axes: readonly number[];
  buttons: readonly { value?: number; pressed?: boolean }[];
}

export interface ControlsEnv {
  /** Defaults to `navigator.getGamepads` where the browser has it. */
  getGamepads?: () => ArrayLike<GamepadLike | null>;
  /** Defaults to the global window. */
  window?: Window;
}

type KeyAction = "left" | "right" | "gas" | "reverse" | "brake" | "handbrake" | "fire" | "missile" | "special";

/** Keyboard bindings: WASD or arrows drive, Space (or J) fires, Q (or K) a missile, E (or L) the special, Shift the handbrake, B the brake. */
const KEY_ACTIONS: Readonly<Record<string, KeyAction>> = {
  arrowleft: "left", a: "left",
  arrowright: "right", d: "right",
  arrowup: "gas", w: "gas",
  arrowdown: "reverse", s: "reverse",
  b: "brake",
  shift: "handbrake",
  " ": "fire", j: "fire",
  q: "missile", k: "missile",
  e: "special", l: "special",
};

/** Steering from a touch drag: nothing inside the deadzone, then a straight ramp to full lock at `maxDragPx`, with no jump at the edge. */
export function dragToSteer(dx: number, deadzonePx: number = CONTROLS.deadzonePx, maxDragPx: number = CONTROLS.maxDragPx): number {
  const reach = Math.abs(dx);
  if (!(reach > deadzonePx)) return 0;
  return Math.sign(dx) * Math.min(1, (reach - deadzonePx) / (maxDragPx - deadzonePx));
}

/** Throttle from a touch drag: on by default, reverse once the drag goes far enough down the screen. */
export function dragToThrottle(dy: number, reverseDragPx: number = CONTROLS.reverseDragPx): number {
  return dy > reverseDragPx ? -1 : 1;
}

/** Steering from a stick: a radial deadzone, rescaled so the edge of the deadzone is zero and full travel is one. */
export function stickToSteer(x: number, y: number, deadzone: number = CONTROLS.stickDeadzone): number {
  const reach = Math.hypot(x, y);
  if (!(reach > deadzone)) return 0;
  return clampUnit((x / reach) * Math.min(1, (reach - deadzone) / (1 - deadzone)));
}

const buttonValue = (b: { value?: number; pressed?: boolean } | undefined): number => b?.value ?? (b?.pressed ? 1 : 0);
const isDown = (b: { value?: number; pressed?: boolean } | undefined): boolean => Boolean(b?.pressed) || buttonValue(b) > CONTROLS.buttonThreshold;

/** The first non-zero value, so one device at a time wins an axis. */
const firstActive = (...values: number[]): number => values.find((v) => v !== 0) ?? 0;

const isTextField = (target: EventTarget | null): boolean => {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  return el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.tagName === "SELECT" || el?.isContentEditable === true;
};

/**
 * The one controls adapter: keyboard, gamepad and touch all end up as the same `InputIntent`.
 * Nothing downstream of `sample` knows which device the player used.
 */
export function createControls(env: ControlsEnv = {}): Controls {
  const keys = new Set<KeyAction>();
  const touchButtons: Record<TouchButton, Set<number>> = { fire: new Set(), missile: new Set(), special: new Set() };
  const padDown = { missile: false, special: false };
  const latch = { missile: false, special: false };
  let keyboardSteer = 0;
  let steerId: number | null = null;
  let origin = { x: 0, y: 0 };
  let drag = { x: 0, y: 0 };
  let touchDriving = false;

  const readPad = (): GamepadLike | null => {
    const getter = env.getGamepads ?? (typeof navigator !== "undefined" && typeof navigator.getGamepads === "function" ? () => navigator.getGamepads() : undefined);
    if (!getter) return null;
    for (const pad of Array.from(getter())) if (pad) return pad;
    return null;
  };

  const fireLatch = (shot: "missile" | "special"): void => { latch[shot] = true; };

  function clear(): void {
    keys.clear();
    for (const held of Object.values(touchButtons)) held.clear();
    padDown.missile = false;
    padDown.special = false;
    latch.missile = false;
    latch.special = false;
    keyboardSteer = 0;
    steerId = null;
    drag = { x: 0, y: 0 };
    touchDriving = false;
  }

  const touch: TouchInput = {
    steerStart(id, x, y) {
      if (steerId !== null) return;
      steerId = id;
      origin = { x, y };
      drag = { x: 0, y: 0 };
      touchDriving = true;
    },
    steerMove(id, x, y) {
      if (id !== steerId) return;
      drag = { x: x - origin.x, y: y - origin.y };
    },
    steerEnd(id) {
      if (id !== steerId) return;
      steerId = null;
      drag = { x: 0, y: 0 };
    },
    press(button, id) {
      touchDriving = true;
      const held = touchButtons[button];
      if (held.size === 0 && button !== "fire") fireLatch(button);
      held.add(id);
    },
    release(button, id) {
      touchButtons[button].delete(id);
    },
  };

  function key(down: boolean, rawKey: string): boolean {
    const action = KEY_ACTIONS[rawKey.toLowerCase()];
    if (!action) return false;
    if (!down) { keys.delete(action); return true; }
    // Auto-repeat sends key-down again for a key that is already down; only the first one is a press.
    if (!keys.has(action) && (action === "missile" || action === "special")) fireLatch(action);
    keys.add(action);
    return true;
  }

  return {
    sample(dtSeconds = 1) {
      const dt = dtSeconds > 0 ? dtSeconds : 0;
      const target = (keys.has("right") ? 1 : 0) - (keys.has("left") ? 1 : 0);
      const step = CONTROLS.keyboardSteerPerSecond * dt;
      keyboardSteer += Math.max(-step, Math.min(step, target - keyboardSteer));

      const pad = readPad();
      let padSteer = 0;
      let padThrottle = 0;
      let padFire = false;
      let padBrake = false;
      let padHandbrake = false;
      if (pad) {
        padSteer = stickToSteer(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
        padThrottle = buttonValue(pad.buttons[7]) - buttonValue(pad.buttons[6]);
        padFire = isDown(pad.buttons[0]);
        padBrake = isDown(pad.buttons[3]);
        padHandbrake = isDown(pad.buttons[4]) || isDown(pad.buttons[5]);
      }
      const missileDown = isDown(pad?.buttons[1]);
      const specialDown = isDown(pad?.buttons[2]);
      if (missileDown && !padDown.missile) fireLatch("missile");
      if (specialDown && !padDown.special) fireLatch("special");
      padDown.missile = missileDown;
      padDown.special = specialDown;

      const touchSteer = steerId === null ? 0 : dragToSteer(drag.x);
      const touchThrottle = !touchDriving ? 0 : steerId === null ? 1 : dragToThrottle(drag.y);
      const keyThrottle = (keys.has("gas") ? 1 : 0) - (keys.has("reverse") ? 1 : 0);

      return {
        ...IDLE_INTENT,
        steer: clampUnit(firstActive(keyboardSteer, padSteer, touchSteer)),
        throttle: clampUnit(firstActive(keyThrottle, padThrottle, touchThrottle)),
        brake: keys.has("brake") || padBrake,
        handbrake: keys.has("handbrake") || padHandbrake,
        fire: keys.has("fire") || padFire || touchButtons.fire.size > 0,
        missile: latch.missile,
        special: latch.special,
      };
    },
    consume() {
      latch.missile = false;
      latch.special = false;
    },
    clear,
    key,
    touch,
    attach() {
      const win = env.window ?? (typeof window !== "undefined" ? window : undefined);
      if (!win) return () => undefined;
      const doc = win.document;
      const onKey = (down: boolean) => (event: KeyboardEvent) => {
        if (event.ctrlKey || event.metaKey || event.altKey || isTextField(event.target)) return;
        if (key(down, event.key)) event.preventDefault();
      };
      const keyDown = onKey(true);
      const keyUp = onKey(false);
      const onHidden = (): void => { if (doc.hidden) clear(); };
      // A rotation changes the layout under a finger; a resize that keeps the orientation (a collapsing address bar) does not.
      let landscape = win.innerWidth > win.innerHeight;
      const onResize = (): void => {
        const now = win.innerWidth > win.innerHeight;
        if (now !== landscape) { landscape = now; clear(); }
      };
      win.addEventListener("keydown", keyDown);
      win.addEventListener("keyup", keyUp);
      win.addEventListener("blur", clear);
      win.addEventListener("pagehide", clear);
      win.addEventListener("touchcancel", clear);
      win.addEventListener("orientationchange", clear);
      win.addEventListener("resize", onResize);
      doc.addEventListener("visibilitychange", onHidden);
      return () => {
        win.removeEventListener("keydown", keyDown);
        win.removeEventListener("keyup", keyUp);
        win.removeEventListener("blur", clear);
        win.removeEventListener("pagehide", clear);
        win.removeEventListener("touchcancel", clear);
        win.removeEventListener("orientationchange", clear);
        win.removeEventListener("resize", onResize);
        doc.removeEventListener("visibilitychange", onHidden);
        clear();
      };
    },
  };
}

/** Buzz the device when the player's car takes a hit. Returns whether it vibrated; devices without vibration just skip it. */
export function vibrateOnHit(events: readonly SimEvent[], playerId: string, vibrate?: (ms: number) => boolean): boolean {
  const buzz = vibrate ?? (typeof navigator !== "undefined" && typeof navigator.vibrate === "function" ? (ms: number) => navigator.vibrate(ms) : undefined);
  if (!buzz || !events.some((e) => e.kind === "hit" && e.targetId === playerId)) return false;
  buzz(CONTROLS.hitVibrationMs);
  return true;
}
