import { useFrame, useThree } from "@react-three/fiber";
import { useRef, type RefObject } from "react";
import { PerspectiveCamera, Vector3 } from "three";

export interface ChaseTarget { x: number; z: number; heading: number; speed: number }
export interface ChaseShot { position: [number, number, number]; look: [number, number, number]; fov: number }

/** Shortest signed turn from one angle to another, in radians. */
export function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/** Where the camera wants to be: behind and above the car, further back and wider when fast. */
export function chaseShot(car: ChaseTarget, smoothedHeading: number, maxSpeed: number): ChaseShot {
  const fast = Math.max(0, Math.min(1, Math.abs(car.speed) / maxSpeed));
  const back = 8.5 + fast * 3.5;
  const up = 3.6 + fast * 1.2;
  const fx = Math.sin(smoothedHeading);
  const fz = Math.cos(smoothedHeading);
  return {
    position: [car.x - fx * back, up, car.z - fz * back],
    look: [car.x + fx * 6, 1.3, car.z + fz * 6],
    fov: 62 + fast * 12,
  };
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
  useFrame((_, delta) => {
    const pose = car.current;
    if (!pose) return;
    const dt = Math.min(delta, 0.1);
    heading.current = heading.current === null ? pose.heading : heading.current + angleDelta(heading.current, pose.heading) * (1 - Math.exp(-4.5 * dt));
    const shot = chaseShot(pose, heading.current, maxSpeed);
    const want = new Vector3(...shot.position);
    const aim = new Vector3(...shot.look);
    if (!placed.current) { camera.position.copy(want); look.current.copy(aim); placed.current = true; }
    else {
      camera.position.lerp(want, 1 - Math.exp(-9 * dt));
      look.current.lerp(aim, 1 - Math.exp(-12 * dt));
    }
    camera.lookAt(look.current);
    const perspective = camera as PerspectiveCamera;
    if (perspective.isPerspectiveCamera && Math.abs(perspective.fov - shot.fov) > 0.05) {
      perspective.fov += (shot.fov - perspective.fov) * (1 - Math.exp(-3 * dt));
      perspective.updateProjectionMatrix();
    }
  }, -1);
  return null;
}
