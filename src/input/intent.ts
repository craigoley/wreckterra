import { CONTRACT_VERSION, type InputCommand } from "../sim/contracts";

/**
 * What the player wants the car to do right now, whatever device said so. Keyboard, gamepad and
 * touch all reduce to this one shape; the simulation reads it and never a device.
 *
 * `missile` and `special` are one-shot latches: they are set on the rising edge of the button and
 * stay set until the simulation acts on them (see `Controls.consume`), so a held button, or
 * several simulation sub-steps in one frame, spend a single shot.
 */
export interface InputIntent {
  /** -1 (full left) .. 1 (full right) */
  steer: number;
  /** -1 (reverse) .. 1 (full throttle) */
  throttle: number;
  brake: boolean;
  /** Held: the gun repeats while it is down. */
  fire: boolean;
  /** One-shot latch. */
  missile: boolean;
  /** One-shot latch. */
  special: boolean;
  handbrake: boolean;
}

export const IDLE_INTENT: Readonly<InputIntent> = Object.freeze({
  steer: 0, throttle: 0, brake: false, fire: false, missile: false, special: false, handbrake: false,
});

export function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

/** The versioned simulation command for an intent. The contract has one brake, so the handbrake joins it. */
export function toCommand(intent: InputIntent, tick: number, playerId: string): InputCommand {
  return {
    v: CONTRACT_VERSION,
    tick,
    playerId,
    steer: clampUnit(intent.steer),
    throttle: clampUnit(intent.throttle),
    brake: intent.brake || intent.handbrake,
    fire: intent.fire,
    missile: intent.missile,
    special: intent.special,
  };
}
