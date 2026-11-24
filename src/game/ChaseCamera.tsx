import { useFrame, useThree } from "@react-three/fiber";
import { useRef, type RefObject } from "react";
import { PerspectiveCamera, Vector3 } from "three";
import { CAMERA } from "../input/tuning";

export interface ChaseTarget { x: number; z: number; heading: number; speed: number }
export interface ChaseShot { position: [number, number, number]; look: [number, number, number]; fov: number }

/** Shortest signed turn from one angle to another, in radians. */
export function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

const fraction = (car: ChaseTarget, maxSpeed: number): number => Math.max(0, Math.min(1, Math.abs(car.speed) / maxSpeed));
const mix = (near: number, far: number, t: number): number => near + (far - near) * t;
/** The share of a per-second smoothing rate that applies over `dt` seconds, so the feel does not depend on frame rate. */
const ease = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

/** Where the camera wants to be: behind and above the car, further back and wider when fast. */
export function chaseShot(car: ChaseTarget, smoothedHeading: number, maxSpeed: number): ChaseShot {
  const fast = fraction(car, maxSpeed);
  const back = mix(CAMERA.backNear, CAMERA.backFar, fast);
  const up = mix(CAMERA.upNear, CAMERA.upFar, fast);
  const fx = Math.sin(smoothedHeading);
  const fz = Math.cos(smoothedHeading);
  return {
    position: [car.x - fx * back, up, car.z - fz * back],
    look: [car.x + fx * CAMERA.lookAhead, CAMERA.lookHeight, car.z + fz * CAMERA.lookAhead],
    fov: mix(CAMERA.fovNear, CAMERA.fovFar, fast),
  };
}

/**
 * How far the camera leans into a slide, in radians: the car's speed across the camera's line of
 * sight (it is zero while the car is straight ahead of the camera) turned into a small roll.
 */
export function chaseRoll(car: ChaseTarget, smoothedHeading: number): number {
  const lateral = car.speed * Math.sin(angleDelta(smoothedHeading, car.heading));
  return Math.max(-CAMERA.maxRoll, Math.min(CAMERA.maxRoll, lateral * CAMERA.rollPerLateralSpeed));
}

/**
 * Follows the car from behind and above. The heading the camera trails is smoothed, so a slide or
 * a sharp turn swings the view round instead of snapping it. It reads the car's pose from a ref
 * the driver updates every frame, and runs after the driver so the shot is never a frame late.
 */
export function ChaseCamera({ car, maxSpeed }: { car: RefObject<ChaseTarget>; maxSpeed: number }) {
  const camera = useThree((s) => s.camera);
  const heading = useRef<number | null>(null);
  const placed = useRef(false);
  const look = useRef(new Vector3());
  const roll = useRef(0);
  useFrame((_, delta) => {
    const pose = car.current;
    if (!pose) return;
    const dt = Math.min(delta, CAMERA.maxFrameSeconds);
    heading.current = heading.current === null ? pose.heading : heading.current + angleDelta(heading.current, pose.heading) * ease(CAMERA.headingFollow, dt);
    const shot = chaseShot(pose, heading.current, maxSpeed);
    const want = new Vector3(...shot.position);
    const aim = new Vector3(...shot.look);
    if (!placed.current) { camera.position.copy(want); look.current.copy(aim); placed.current = true; }
    else {
      camera.position.lerp(want, ease(CAMERA.positionFollow, dt));
      look.current.lerp(aim, ease(CAMERA.lookFollow, dt));
    }
    camera.lookAt(look.current);
    // Lean into the slide: the roll is smoothed too, so a flick of the wheel tilts the view gently.
    roll.current += (chaseRoll(pose, heading.current) - roll.current) * ease(CAMERA.rollFollow, dt);
    camera.rotateZ(roll.current);
    const perspective = camera as PerspectiveCamera;
    if (perspective.isPerspectiveCamera && Math.abs(perspective.fov - shot.fov) > 0.05) {
      perspective.fov += (shot.fov - perspective.fov) * ease(CAMERA.fovFollow, dt);
      perspective.updateProjectionMatrix();
    }
  }, -1);
  return null;
}
