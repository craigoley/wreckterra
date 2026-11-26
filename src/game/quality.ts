/**
 * Adaptive render quality. A level is only resolution and shadow detail: nothing here can reach the
 * simulation. The level moves on a full window of measured frame times, never on a lone long frame.
 */
export interface QualityLevel {
  /** Share of the capped device pixel ratio that is rendered. */
  scale: number;
  /** Shadow map size in pixels; 0 turns shadows off. */
  shadow: number;
}

export const QUALITY_LEVELS: readonly QualityLevel[] = [
  { scale: 0.55, shadow: 0 },
  { scale: 0.75, shadow: 1024 },
  { scale: 1, shadow: 2048 },
  { scale: 1.25, shadow: 2048 },
];

/** A denser screen than this is rendered as if it were this dense. */
const MAX_DEVICE_PIXEL_RATIO = 2;
const MIN_PIXEL_RATIO = 0.5;

/** The pixel ratio to render at, for a level on a screen. */
export function renderPixelRatio(level: number, devicePixelRatio: number): number {
  const device = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.max(MIN_PIXEL_RATIO, Math.min(device, MAX_DEVICE_PIXEL_RATIO) * QUALITY_LEVELS[level]!.scale);
}

/** Frames measured before each decision. */
export const FRAME_WINDOW = 60;
/** This many of a window's longest frames are set aside: a hitch is not a sustained frame time. */
const SPIKE_FRAMES = 3;

/** The mean frame time of a window, without its few longest frames. */
export function sustainedFrameTime(frames: readonly number[]): number {
  const kept = [...frames].sort((a, b) => a - b).slice(0, Math.max(1, frames.length - SPIKE_FRAMES));
  return kept.reduce((sum, seconds) => sum + seconds, 0) / kept.length;
}

/** Slower than this steps down at once. */
const SLOW_SECONDS = 1 / 38;
/** Faster than this counts towards stepping up; between the two the level holds. */
const FAST_SECONDS = 1 / 55;
const FAST_WINDOWS_TO_STEP_UP = 3;

export function nextQuality(level: number, frameSeconds: number, goodWindows: number): { level: number; goodWindows: number } {
  if (frameSeconds > SLOW_SECONDS) return { level: Math.max(0, level - 1), goodWindows: 0 };
  if (frameSeconds >= FAST_SECONDS) return { level, goodWindows: 0 };
  if (goodWindows + 1 < FAST_WINDOWS_TO_STEP_UP) return { level, goodWindows: goodWindows + 1 };
  return { level: Math.min(QUALITY_LEVELS.length - 1, level + 1), goodWindows: 0 };
}
