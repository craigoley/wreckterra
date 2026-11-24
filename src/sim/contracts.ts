/**
 * Versioned simulation contracts. Nothing here imports React, the DOM or a renderer, so the same
 * input, event and snapshot shapes can later cross a network boundary unchanged.
 */
export const CONTRACT_VERSION = 1 as const;
export const TICK_RATE = 60;
export const TICK_SECONDS = 1 / TICK_RATE;
/** Upper bound on fixed steps taken for one `advance` call, so a stall never causes a catch-up burst. */
export const MAX_STEPS_PER_ADVANCE = 5;

export interface InputCommand {
  v: typeof CONTRACT_VERSION;
  /** Tick the client believed it was on when sampling; recorded for later reconciliation. */
  tick: number;
  playerId: string;
  /** -1 (full left) .. 1 (full right) */
  steer: number;
  /** -1 (reverse) .. 1 (full throttle) */
  throttle: number;
  brake: boolean;
}

export type InputRejection = "bad-shape" | "bad-version" | "out-of-range" | "unknown-player";

export type InputResult = { accepted: true } | { accepted: false; reason: InputRejection };

export interface VehicleState {
  playerId: string;
  x: number;
  z: number;
  /** Radians. Forward is (sin heading, cos heading). */
  heading: number;
  speed: number;
}

export interface Obstacle {
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
}

export interface ArenaLayout {
  halfExtent: number;
  obstacles: readonly Obstacle[];
}

export type SimEvent =
  | { v: typeof CONTRACT_VERSION; tick: number; kind: "spawned"; playerId: string }
  | { v: typeof CONTRACT_VERSION; tick: number; kind: "impact"; playerId: string; speed: number };

export interface Snapshot {
  v: typeof CONTRACT_VERSION;
  tick: number;
  seed: number;
  vehicles: readonly VehicleState[];
}

/**
 * The authority boundary. Today a local in-process world implements it; a remote server could
 * implement the same surface later without the renderer or UI changing.
 */
export interface LocalAuthority {
  readonly layout: ArenaLayout;
  submitInput(input: unknown): InputResult;
  /** Accumulate real elapsed seconds and run whole fixed ticks. Returns the ticks taken. */
  advance(elapsedSeconds: number): number;
  snapshot(): Snapshot;
  drainEvents(): SimEvent[];
  dispose(): void;
}
