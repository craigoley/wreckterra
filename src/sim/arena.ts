import type { CombatArenaLayout, Obstacle, SpecialKind, VehicleKind } from "./contracts";

/** The original combat arena: a walled lot with cover blocks, two ramps and two pickup pads. */
export const ARENA: CombatArenaLayout = {
  halfExtent: 40,
  obstacles: [
    { x: -14, z: -14, halfX: 3, halfZ: 3 },
    { x: 14, z: -14, halfX: 3, halfZ: 3 },
    { x: 0, z: -2, halfX: 2, halfZ: 6 },
    { x: -22, z: 16, halfX: 4, halfZ: 2 },
    { x: 22, z: 16, halfX: 4, halfZ: 2 },
    { x: 0, z: 14, halfX: 6, halfZ: 1.5 },
  ],
  ramps: [
    { x: -26, z: -18, halfX: 3, halfZ: 5 },
    { x: 26, z: -18, halfX: 3, halfZ: 5 },
  ],
  pads: [
    { id: "health-pad", kind: "health", x: -14, z: 26 },
    { id: "ammo-pad", kind: "ammo", x: 14, z: -24 },
  ],
};

export interface Spawn {
  x: number;
  z: number;
  heading: number;
}

function facingCentre(x: number, z: number): Spawn {
  return { x, z, heading: Math.atan2(-x, -z) };
}

/** Index 0 is the player's start; the rest are bot starts, all well inside the walls and in the open. */
export const SPAWNS: readonly Spawn[] = [
  facingCentre(0, 32),
  facingCentre(-33, -33),
  facingCentre(33, -33),
  facingCentre(-34, -4),
  facingCentre(34, -4),
];

export interface VehicleSpec {
  maxHealth: number;
  maxSpeed: number;
  acceleration: number;
  turnRate: number;
  special: SpecialKind;
}

export const VEHICLE_SPECS: Record<VehicleKind, VehicleSpec> = {
  switchback: { maxHealth: 100, maxSpeed: 20, acceleration: 14, turnRate: 2.2, special: "repair" },
  rivet: { maxHealth: 150, maxSpeed: 15, acceleration: 11, turnRate: 1.8, special: "shockwave" },
  voltage: { maxHealth: 85, maxSpeed: 25, acceleration: 18, turnRate: 2.8, special: "afterburner" },
};

export const VEHICLE_KINDS: readonly VehicleKind[] = ["switchback", "rivet", "voltage"];

/**
 * Distance along a ray (unit direction) to an axis-aligned box, or Infinity when it misses.
 * A ray that starts inside the box reports 0.
 */
export function rayBox(ox: number, oz: number, dx: number, dz: number, box: Obstacle): number {
  let near = 0;
  let far = Infinity;
  const axes: [number, number, number][] = [
    [ox - box.x, dx, box.halfX],
    [oz - box.z, dz, box.halfZ],
  ];
  for (const [origin, dir, half] of axes) {
    if (Math.abs(dir) < 1e-9) {
      if (Math.abs(origin) > half) return Infinity;
      continue;
    }
    const t1 = (-half - origin) / dir;
    const t2 = (half - origin) / dir;
    near = Math.max(near, Math.min(t1, t2));
    far = Math.min(far, Math.max(t1, t2));
    if (near > far) return Infinity;
  }
  return near;
}

/** Nearest cover distance along a ray, or Infinity when the way is open. */
export function rayCover(layout: CombatArenaLayout, ox: number, oz: number, dx: number, dz: number): number {
  let nearest = Infinity;
  for (const box of layout.obstacles) nearest = Math.min(nearest, rayBox(ox, oz, dx, dz, box));
  return nearest;
}

/** True when no cover block sits on the straight line between two points. */
export function lineClear(layout: CombatArenaLayout, ax: number, az: number, bx: number, bz: number): boolean {
  const length = Math.hypot(bx - ax, bz - az);
  if (length < 1e-6) return true;
  return rayCover(layout, ax, az, (bx - ax) / length, (bz - az) / length) >= length;
}
