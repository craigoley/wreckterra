/**
 * The page lifecycle of a solo match. A hidden page or a lost graphics context pauses the fixed-tick
 * loop and any audio; only a player's tap resumes them. The match itself is never touched, so
 * whatever draws it next continues from the same state.
 */
import type { LoopHandle } from "../sim/world";

/** How long a lost graphics context may take to come back before the player is offered a retry. */
export const CONTEXT_RESTORE_TIMEOUT_MS = 5000;

export type GraphicsState = "ok" | "lost" | "unavailable";

export interface LifecycleState {
  /** True while the simulation is held; it stays held until `resume` succeeds. */
  paused: boolean;
  graphics: GraphicsState;
  /** Counts retries: a new number means the view should build a fresh renderer. */
  renderer: number;
}

export const RUNNING: Readonly<LifecycleState> = Object.freeze({ paused: false, graphics: "ok", renderer: 0 });

/** Whatever plays sound; the page lifecycle holds and releases it. */
export interface AudioPort {
  suspend(): unknown;
  resume(): unknown;
}

/** An audio port that can be given back, as a Web Audio context can. */
export interface AudioOutput extends AudioPort {
  close(): unknown;
}

function browserAudio(): AudioOutput | null {
  // Older iPhones only have the prefixed constructor.
  const scope = globalThis as { AudioContext?: new () => AudioOutput; webkitAudioContext?: new () => AudioOutput };
  const Context = scope.AudioContext ?? scope.webkitAudioContext;
  return Context ? new Context() : null;
}

/**
 * The page's real audio output. The game plays no sound yet. No context exists until the first
 * `resume`, which must come from a user gesture; where there is no Web Audio it does nothing.
 */
export function createAudioPort(create: () => AudioOutput | null = browserAudio): AudioOutput {
  let output: AudioOutput | null = null;
  let closed = false;
  return {
    suspend: () => output?.suspend(),
    resume() {
      if (closed) return undefined;
      try { output ??= create(); }
      catch (error) { console.warn("Audio could not be started; the match carries on without it.", error); }
      return output?.resume();
    },
    close() {
      closed = true;
      const open = output;
      output = null;
      quietly(open?.close());
    },
  };
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface PageLifecycleOptions {
  loop: Pick<LoopHandle, "pause" | "resume">;
  /** The element the 3D canvas is drawn inside; its context events are heard in the capture phase. */
  surface?: EventTarget | null;
  audio?: AudioPort;
  /** Called every time the page interrupts the match. */
  onPause?: () => void;
  onChange?: (state: LifecycleState) => void;
  /** Defaults to the global window. */
  window?: Window;
  timers?: Timers;
}

export interface PageLifecycle {
  state(): LifecycleState;
  /** Call only from a user gesture. Refused while the page is hidden or there is nothing to draw with. */
  resume(): boolean;
  /** The view could not be built at all: hold the match and offer the retry. */
  rendererFailed(): void;
  /** Ask for a fresh renderer. The match stays paused until the player resumes it. */
  retry(): void;
  dispose(): void;
}

const browserTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const quietly = (result: unknown): void => {
  void Promise.resolve(result).catch((error: unknown) => console.warn("Audio did not change state.", error));
};

export function bindPageLifecycle(options: PageLifecycleOptions): PageLifecycle {
  const win = options.window ?? window;
  const doc = win.document;
  const timers = options.timers ?? browserTimers;
  let state: LifecycleState = { ...RUNNING };
  let timer: unknown;
  let lostCanvas: EventTarget | null = null;
  let disposed = false;

  const change = (next: Partial<LifecycleState>): void => {
    state = { ...state, ...next };
    options.onChange?.(state);
  };
  const stopWaiting = (): void => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
  };
  const pause = (next: Partial<LifecycleState> = {}): void => {
    if (disposed) return;
    options.loop.pause();
    if (options.audio) quietly(options.audio.suspend());
    options.onPause?.();
    change({ ...next, paused: true });
  };

  const onHidden = (): void => { if (doc.hidden) pause(); };
  const onPageHide = (): void => pause();

  const onRestored = (event: Event): void => {
    if (disposed || event.target !== lostCanvas) return;
    lostCanvas = null;
    stopWaiting();
    change({ graphics: "ok" });
  };
  const onLost = (event: Event): void => {
    // Without this the browser never offers the context back.
    event.preventDefault();
    lostCanvas = event.target;
    // The view may remove the canvas while it recovers, so listen on the canvas itself.
    lostCanvas?.addEventListener("webglcontextrestored", onRestored, { once: true });
    stopWaiting();
    timer = timers.set(() => { timer = undefined; change({ graphics: "unavailable" }); }, CONTEXT_RESTORE_TIMEOUT_MS);
    pause({ graphics: "lost" });
  };

  doc.addEventListener("visibilitychange", onHidden);
  win.addEventListener("pagehide", onPageHide);
  options.surface?.addEventListener("webglcontextlost", onLost, true);
  // A match that starts in a background tab starts paused.
  onHidden();

  return {
    state: () => state,
    resume() {
      if (disposed || doc.hidden || state.graphics !== "ok") return false;
      // This is the player's gesture, so audio may start here, on a restart during play too.
      if (options.audio) quietly(options.audio.resume());
      if (!state.paused) return true;
      // The loop forgets its last frame time here, so the time away is never replayed.
      options.loop.resume();
      change({ paused: false });
      return true;
    },
    rendererFailed() {
      if (disposed || state.graphics === "unavailable") return;
      stopWaiting();
      pause({ graphics: "unavailable" });
    },
    retry() {
      if (disposed || state.graphics !== "unavailable") return;
      lostCanvas = null;
      change({ graphics: "ok", renderer: state.renderer + 1 });
    },
    dispose() {
      disposed = true;
      stopWaiting();
      doc.removeEventListener("visibilitychange", onHidden);
      win.removeEventListener("pagehide", onPageHide);
      options.surface?.removeEventListener("webglcontextlost", onLost, true);
      lostCanvas?.removeEventListener("webglcontextrestored", onRestored);
    },
  };
}
