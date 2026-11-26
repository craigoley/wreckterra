/**
 * Phone-first driving input. Keyboard, gamepad and touch still end up as the one `InputIntent`; this
 * adds what a thumb needs on top: a brake button, an optional assisted accelerator that backs out
 * when the car is stuck, and the release of every held control when the page interrupts the player.
 */
import { createControls, type Controls, type ControlsEnv, type TouchInput } from "../input/controls";
import type { InputIntent } from "../input/intent";

export const ASSIST_KEY = "wreckterra.assisted-throttle";

/** Stuck means the assisted accelerator is on and the car is barely moving, counted in simulation ticks. */
export const STUCK = {
  /** Below this speed in metres per second the car counts as not getting anywhere. */
  speed: 1.5,
  /** This many slow ticks starts a reverse. */
  ticks: 45,
  /** How long the car backs out for. */
  reverseTicks: 40,
} as const;

/** What the stuck check needs to know about the player's car. */
export interface Motion {
  tick: number;
  speed: number;
}

export interface AssistStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DrivingEnv extends ControlsEnv {
  /** Where the assisted accelerator choice is kept; defaults to the browser's local storage. */
  storage?: AssistStorage | null;
}

export interface DrivingControls extends Controls {
  /** Pass the player's motion to let the assisted accelerator back out of a wall. */
  sample(dtSeconds?: number, motion?: Motion): InputIntent;
  /** An on-screen brake held by one pointer. */
  brake(down: boolean, id: number): void;
  /** On: a touch keeps the car driving. Off: it drives only while the steering thumb is down. */
  readonly assist: boolean;
  setAssist(on: boolean): void;
  /** Hear every `clear`, so on-screen controls forget the fingers they were tracking. Returns the unsubscribe. */
  onRelease(listener: () => void): () => void;
  /** Listen to the keyboard. `bindDrivingInput` adds the interruptions that release every device. */
  attach(): () => void;
}

function browserStorage(): AssistStorage | null {
  try { return typeof window !== "undefined" ? window.localStorage : null; }
  catch (error) { console.warn("Driving settings will not be saved: storage is blocked.", error); return null; }
}

function readAssist(storage: AssistStorage | null): boolean {
  try { return storage?.getItem(ASSIST_KEY) !== "off"; }
  catch (error) { console.warn("The saved accelerator setting could not be read.", error); return true; }
}

/** Counts slow ticks and, past the limit, overrides the intent with a short counter-steered reverse. */
function createStuckRecovery() {
  let slow = 0;
  let lastTick: number | null = null;
  let reverseUntil: number | null = null;
  const reset = (): void => { slow = 0; lastTick = null; reverseUntil = null; };
  return {
    reset,
    apply(intent: InputIntent, motion: Motion): InputIntent {
      // A restarted match counts its ticks from zero again.
      if (lastTick !== null && motion.tick < lastTick) reset();
      const passed = lastTick === null ? 0 : motion.tick - lastTick;
      lastTick = motion.tick;
      if (reverseUntil !== null && motion.tick >= reverseUntil) reverseUntil = null;
      if (reverseUntil === null) {
        slow = Math.abs(motion.speed) < STUCK.speed ? slow + passed : Math.max(0, slow - 2 * passed);
        if (slow < STUCK.ticks) return intent;
        slow = 0;
        reverseUntil = motion.tick + STUCK.reverseTicks;
      }
      return { ...intent, throttle: -1, steer: intent.steer === 0 ? 1 : -intent.steer };
    },
  };
}

export function createDrivingControls(env: DrivingEnv = {}): DrivingControls {
  // Two adapters, so the thumbs' automatic throttle can be told apart from a key or a trigger.
  const devices = createControls(env);
  const thumbs = createControls({ window: env.window, getGamepads: () => [] });
  const storage = env.storage === undefined ? browserStorage() : env.storage;
  const listeners = new Set<() => void>();
  const brakes = new Set<number>();
  const stuck = createStuckRecovery();
  let steering: number | null = null;
  let assist = readAssist(storage);

  const touch: TouchInput = {
    steerStart(id, x, y) {
      steering ??= id;
      thumbs.touch.steerStart(id, x, y);
    },
    steerMove: (id, x, y) => thumbs.touch.steerMove(id, x, y),
    steerEnd(id) {
      if (steering === id) steering = null;
      thumbs.touch.steerEnd(id);
    },
    press: (button, id) => thumbs.touch.press(button, id),
    release: (button, id) => thumbs.touch.release(button, id),
  };

  return {
    sample(dtSeconds = 1, motion) {
      const hard = devices.sample(dtSeconds);
      const soft = thumbs.sample(dtSeconds);
      const braked = brakes.size > 0;
      let thumbThrottle = assist || steering !== null ? soft.throttle : 0;
      // The brake always beats the automatic throttle; dragging down still reverses.
      if (braked) thumbThrottle = Math.min(0, thumbThrottle);
      const intent: InputIntent = {
        steer: hard.steer || soft.steer,
        throttle: hard.throttle || thumbThrottle,
        brake: hard.brake || braked,
        handbrake: hard.handbrake,
        fire: hard.fire || soft.fire,
        missile: hard.missile || soft.missile,
        special: hard.special || soft.special,
      };
      const automatic = assist && hard.throttle === 0 && thumbThrottle > 0 && !intent.brake;
      if (!automatic) { stuck.reset(); return intent; }
      return motion ? stuck.apply(intent, motion) : intent;
    },
    consume() {
      devices.consume();
      thumbs.consume();
    },
    clear() {
      devices.clear();
      thumbs.clear();
      brakes.clear();
      stuck.reset();
      steering = null;
      for (const listener of [...listeners]) listener();
    },
    key: (down, key) => devices.key(down, key),
    touch,
    attach: () => devices.attach(),
    brake(down, id) {
      if (down) brakes.add(id);
      else brakes.delete(id);
    },
    get assist() {
      return assist;
    },
    setAssist(on) {
      assist = on;
      try { storage?.setItem(ASSIST_KEY, on ? "on" : "off"); }
      catch (error) { console.warn("The accelerator setting could not be saved.", error); }
    },
    onRelease(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export interface DrivingBinding {
  /** The element the controls are laid out in; a change of its size is a reflow under the player's fingers. */
  surface?: Element | null;
  /** Called on every release, in the same tick, so the simulation can drop the command it is holding. */
  onRelease?: () => void;
  /** Defaults to the global window. */
  window?: Window;
}

/**
 * Listen to the keyboard, and release every held control when focus or visibility is lost, a touch is
 * cancelled, or the layout changes in any way. Returns the function that stops listening.
 */
export function bindDrivingInput(controls: DrivingControls, binding: DrivingBinding = {}): () => void {
  const win = binding.window ?? window;
  const doc = win.document;
  const release = (): void => controls.clear();
  const onHidden = (): void => { if (doc.hidden) release(); };
  const unsubscribe = binding.onRelease ? controls.onRelease(binding.onRelease) : undefined;
  const detachKeys = controls.attach();
  const events = ["blur", "pagehide", "touchcancel", "orientationchange", "resize"] as const;
  for (const name of events) win.addEventListener(name, release);
  // The visual viewport changes on its own when a browser bar or an on-screen keyboard moves.
  const viewport = win.visualViewport;
  viewport?.addEventListener("resize", release);
  doc.addEventListener("visibilitychange", onHidden);

  const Observer = (win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  let observer: ResizeObserver | undefined;
  if (binding.surface && Observer) {
    let size: string | null = null;
    observer = new Observer((entries) => {
      for (const entry of entries) {
        const next = `${entry.contentRect.width}x${entry.contentRect.height}`;
        // The first report is the size at the start, not a change.
        if (size !== null && next !== size) release();
        size = next;
      }
    });
    observer.observe(binding.surface);
  }

  return () => {
    observer?.disconnect();
    for (const name of events) win.removeEventListener(name, release);
    viewport?.removeEventListener("resize", release);
    doc.removeEventListener("visibilitychange", onHidden);
    detachKeys();
    release();
    unsubscribe?.();
  };
}
