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
  /** Optional combat controls; absent means not pressed, so version-1 drive-only inputs stay valid. */
  fire?: boolean;
  missile?: boolean;
  special?: boolean;
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

export type VehicleKind = "switchback" | "rivet" | "voltage";
export type WeaponKind = "gun" | "missile" | "special";
export type SpecialKind = "repair" | "shockwave" | "afterburner";
export type PickupKind = "health" | "ammo";
export type MatchStatus = "running" | "won" | "lost";
export type MatchReason = "last-car-running" | "wrecked" | "time-limit";

type Stamp = { v: typeof CONTRACT_VERSION; tick: number };

export type SimEvent =
  | (Stamp & { kind: "spawned"; playerId: string })
  | (Stamp & { kind: "impact"; playerId: string; speed: number })
  /** A gun shot from the shooter to where it ended (a target, cover or maximum range). */
  | (Stamp & { kind: "shot"; playerId: string; x: number; z: number; toX: number; toZ: number })
  | (Stamp & { kind: "missile-launched"; playerId: string; targetId: string | null })
  | (Stamp & { kind: "hit"; playerId: string; targetId: string; weapon: WeaponKind; damage: number; x: number; z: number })
  | (Stamp & { kind: "wrecked"; playerId: string; byId: string | null; x: number; z: number })
  | (Stamp & { kind: "pickup"; playerId: string; padId: string; pickup: PickupKind })
  | (Stamp & { kind: "pickup-ready"; padId: string })
  | (Stamp & { kind: "special"; playerId: string; special: SpecialKind })
  | (Stamp & { kind: "launch"; playerId: string })
  | (Stamp & { kind: "match-ended"; status: MatchStatus; reason: MatchReason });

/** A ramp: driving onto it at speed launches the vehicle. */
export interface Ramp {
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
}

export interface PickupPad {
  id: string;
  kind: PickupKind;
  x: number;
  z: number;
}

export interface CombatArenaLayout extends ArenaLayout {
  ramps: readonly Ramp[];
  pads: readonly PickupPad[];
}

export interface CombatVehicleState extends VehicleState {
  kind: VehicleKind;
  bot: boolean;
  health: number;
  maxHealth: number;
  alive: boolean;
  missiles: number;
  maxMissiles: number;
  special: SpecialKind;
  /** Ticks until the special is ready again; 0 means ready. */
  specialCooldown: number;
  /** The enemy the missile would home on right now, or null when nothing is locked. */
  lockId: string | null;
  lastHitTick: number;
  wreckedTick: number | null;
  /** Ticks of airtime left after a ramp launch. */
  airborne: number;
  /** Ticks of afterburner left. */
  boost: number;
}

export interface MissileState {
  id: number;
  ownerId: string;
  x: number;
  z: number;
  heading: number;
  targetId: string | null;
}

export interface PickupState extends PickupPad {
  ready: boolean;
  /** Ticks until the pad is ready again. */
  respawnTicks: number;
}

export interface MatchState {
  status: MatchStatus;
  reason: MatchReason | null;
  /** Tick the match ended on, or null while it is running. */
  endedTick: number | null;
  timeLimitTicks: number;
  botsAlive: number;
}

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

export interface CombatSnapshot extends Snapshot {
  vehicles: readonly CombatVehicleState[];
  missiles: readonly MissileState[];
  pickups: readonly PickupState[];
  match: MatchState;
}

/** A local authority that runs one combat match. */
export interface CombatAuthority extends LocalAuthority {
  readonly layout: CombatArenaLayout;
  snapshot(): CombatSnapshot;
  /** Begin a fresh match from the same seed and options. */
  restart(): void;
}
