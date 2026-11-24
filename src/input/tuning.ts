/** Every control and camera constant lives here, so feel is tuned in one place and nowhere else. */

export const CONTROLS = {
  /** Touch: drag inside this many pixels of the touch origin does not steer. */
  deadzonePx: 14,
  /** Touch: a drag this far from the origin is full lock; steering ramps linearly from the deadzone edge to here. */
  maxDragPx: 84,
  /** Touch: dragging down further than this reverses; throttle is otherwise on. */
  reverseDragPx: 56,
  /** Keyboard: how fast the steering moves to the pressed direction, in full-lock units per second. */
  keyboardSteerPerSecond: 6,
  /** Gamepad: the left stick's radial deadzone, as a fraction of its travel. */
  stickDeadzone: 0.15,
  /** Gamepad: a trigger or button counts as pressed above this value. */
  buttonThreshold: 0.5,
  /** Vibration on a hit to the player, in milliseconds, where the device supports it. */
  hitVibrationMs: 40,
} as const;

export const CAMERA = {
  /** Distance behind the car, standing and at top speed. */
  backNear: 8.5,
  backFar: 12,
  /** Height above the ground, standing and at top speed. */
  upNear: 3.6,
  upFar: 4.8,
  /** How far ahead of the car the camera looks. */
  lookAhead: 6,
  lookHeight: 1.3,
  /** Field of view in degrees, standing and at top speed. */
  fovNear: 62,
  fovFar: 74,
  /** Per-second smoothing rates (higher is snappier). */
  headingFollow: 4.5,
  positionFollow: 9,
  lookFollow: 12,
  fovFollow: 3,
  rollFollow: 5,
  /** Roll in radians per metre per second of sideways speed, and the most it may roll. */
  rollPerLateralSpeed: 0.006,
  maxRoll: 0.09,
  /** Longest frame the camera will smooth over, in seconds. */
  maxFrameSeconds: 0.1,
} as const;
