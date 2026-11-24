import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { AdditiveBlending, BoxGeometry, Color, DynamicDrawUsage, InstancedMesh, MeshBasicMaterial, Object3D, Quaternion, SphereGeometry, Vector3 } from "three";
import { PLAYER_ID } from "../sim/combat";
import { TICK_RATE, type CombatSnapshot, type CombatVehicleState, type SimEvent } from "../sim/contracts";

/** A visual the renderer should show for one simulation event. Pure data, so it can be tested without WebGL. */
export interface Effect {
  kind: "muzzle" | "tracer" | "sparks" | "explosion";
  tick: number;
  x: number;
  z: number;
  toX?: number;
  toZ?: number;
  /** A wreck going up rather than a missile burst. */
  big?: boolean;
}

/** Turn simulation events into effects: muzzle flash and tracer per shot, sparks per gun hit, a fireball per missile hit and wreck. */
export function effectsFromEvents(events: readonly SimEvent[]): Effect[] {
  const out: Effect[] = [];
  for (const e of events) {
    if (e.kind === "shot") {
      out.push({ kind: "muzzle", tick: e.tick, x: e.x, z: e.z });
      out.push({ kind: "tracer", tick: e.tick, x: e.x, z: e.z, toX: e.toX, toZ: e.toZ });
    } else if (e.kind === "hit") {
      out.push({ kind: e.weapon === "missile" ? "explosion" : "sparks", tick: e.tick, x: e.x, z: e.z });
    } else if (e.kind === "wrecked") {
      out.push({ kind: "explosion", tick: e.tick, x: e.x, z: e.z, big: true });
    }
  }
  return out;
}

/** How hard the camera should jolt for the events that happened to the player: hits, impacts and the wreck. */
export function shakeFromEvents(events: readonly SimEvent[], playerId: string = PLAYER_ID): number {
  let shake = 0;
  for (const e of events) {
    if (e.kind === "hit" && e.targetId === playerId) shake = Math.max(shake, e.weapon === "gun" ? 0.12 : 0.5);
    else if (e.kind === "impact" && e.playerId === playerId) shake = Math.max(shake, Math.min(0.5, e.speed / 40));
    else if (e.kind === "wrecked" && e.playerId === playerId) shake = Math.max(shake, 0.9);
  }
  return shake;
}

/** Keep the bus from growing while nothing is drawing (no WebGL, a hidden tab). */
export const BUS_LIMIT = 256;

/** Events travel from the simulation loop to the 3D view through one of these. */
export interface EffectsBus { events: SimEvent[] }

export function pushToBus(bus: EffectsBus, events: readonly SimEvent[]): void {
  if (events.length === 0) return;
  bus.events.push(...events);
  if (bus.events.length > BUS_LIMIT) bus.events.splice(0, bus.events.length - BUS_LIMIT);
}

/* ---------------------------------------------------------------- particles */

const GLOW_COUNT = 360;
const SMOKE_COUNT = 240;
const TRACER_COUNT = 40;
const WRECK_BURN_SECONDS = 40;
const DEAD = -1;

interface Particle { life: number; max: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; size: number; grow: number; gravity: number; r: number; g: number; b: number }
interface Tracer { life: number; max: number; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

const pool = (n: number): Particle[] => Array.from({ length: n }, () => ({ life: DEAD, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 0, grow: 0, gravity: 0, r: 1, g: 1, b: 1 }));

/** Visual-only randomness: a small LCG, never the simulation's generator, so effects cannot change a match. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

interface Burst { life: number; max: number; x: number; y: number; z: number; size: number }

/**
 * Muzzle flashes, tracers, sparks, missile trails, explosions, smoke from hurt cars and burning
 * wrecks, all drawn with three instanced meshes so a firefight costs a handful of draw calls, and
 * a camera jolt when the player is hit. It must not use a positive useFrame priority: that would take over rendering from R3F. It reads the newest snapshot each frame and drains `bus` for events.
 */
export function CombatEffects({ live, bus }: { live: MutableRefObject<CombatSnapshot>; bus: MutableRefObject<EffectsBus> }) {
  const camera = useThree((s) => s.camera);
  const glowMesh = useRef<InstancedMesh>(null);
  const smokeMesh = useRef<InstancedMesh>(null);
  const tracerMesh = useRef<InstancedMesh>(null);
  const state = useMemo(() => ({
    glow: pool(GLOW_COUNT),
    smoke: pool(SMOKE_COUNT),
    tracers: Array.from({ length: TRACER_COUNT }, (): Tracer => ({ life: DEAD, max: 1, x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0 })),
    bursts: [] as Burst[],
    nextGlow: 0,
    nextSmoke: 0,
    nextTracer: 0,
    rand: lcg(20261124),
    shake: 0,
    clock: 0,
    missiles: new Map<number, { x: number; z: number }>(),
    lastTick: 0,
  }), []);
  const dummy = useMemo(() => new Object3D(), []);
  const tint = useMemo(() => new Color(), []);
  const up = useMemo(() => new Vector3(0, 0, 1), []);
  const dir = useMemo(() => new Vector3(), []);
  const quat = useMemo(() => new Quaternion(), []);
  const glowGeometry = useMemo(() => new SphereGeometry(1, 6, 4), []);
  const tracerGeometry = useMemo(() => new BoxGeometry(1, 1, 1), []);
  const glowMaterial = useMemo(() => new MeshBasicMaterial({ blending: AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }), []);
  const smokeMaterial = useMemo(() => new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.55, depthWrite: false }), []);
  const tracerMaterial = useMemo(() => new MeshBasicMaterial({ color: "#ffe9a0", blending: AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }), []);
  useEffect(() => () => { glowGeometry.dispose(); tracerGeometry.dispose(); glowMaterial.dispose(); smokeMaterial.dispose(); tracerMaterial.dispose(); }, [glowGeometry, tracerGeometry, glowMaterial, smokeMaterial, tracerMaterial]);
  useEffect(() => {
    for (const mesh of [glowMesh.current, smokeMesh.current, tracerMesh.current]) {
      if (!mesh) continue;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
    }
  }, []);

  const spawn = (list: Particle[], at: "glow" | "smoke", p: Partial<Particle> & { life: number }): void => {
    const index = at === "glow" ? state.nextGlow++ % list.length : state.nextSmoke++ % list.length;
    Object.assign(list[index]!, { max: p.life, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 0.3, grow: 0, gravity: 0, r: 1, g: 1, b: 1 }, p);
  };
  const sparks = (x: number, y: number, z: number, count: number, speed: number): void => {
    for (let i = 0; i < count; i += 1) {
      const a = state.rand() * Math.PI * 2;
      const s = speed * (0.4 + state.rand() * 0.8);
      spawn(state.glow, "glow", { life: 0.2 + state.rand() * 0.25, x, y, z, vx: Math.cos(a) * s, vy: 2 + state.rand() * speed * 0.6, vz: Math.sin(a) * s, size: 0.1 + state.rand() * 0.08, gravity: 18, r: 1, g: 0.75, b: 0.3 });
    }
  };
  const explode = (x: number, z: number, big: boolean): void => {
    const scale = big ? 1.6 : 1;
    state.bursts.push({ life: 0.16, max: 0.16, x, y: 1.4, z, size: 4.5 * scale });
    for (let i = 0; i < 18 * scale; i += 1) {
      const a = state.rand() * Math.PI * 2;
      const s = (2 + state.rand() * 8) * scale;
      spawn(state.glow, "glow", { life: 0.35 + state.rand() * 0.45, x, y: 1.2, z, vx: Math.cos(a) * s, vy: 1 + state.rand() * 7 * scale, vz: Math.sin(a) * s, size: (0.6 + state.rand() * 0.9) * scale, grow: -0.9, gravity: 6, r: 1, g: 0.45 + state.rand() * 0.4, b: 0.1 });
    }
    for (let i = 0; i < 12 * scale; i += 1) {
      const a = state.rand() * Math.PI * 2;
      const s = 1 + state.rand() * 4;
      spawn(state.smoke, "smoke", { life: 1.2 + state.rand() * 1.4, x, y: 1.5, z, vx: Math.cos(a) * s, vy: 2 + state.rand() * 3, vz: Math.sin(a) * s, size: 0.9 + state.rand() * 0.8, grow: 1.4 * scale, r: 0.25, g: 0.25, b: 0.27 });
    }
    sparks(x, 1.2, z, big ? 16 : 8, 9);
  };

  const emit = (effect: Effect): void => {
    if (effect.kind === "muzzle") {
      spawn(state.glow, "glow", { life: 0.06, x: effect.x, y: 1.9, z: effect.z, size: 0.55, r: 1, g: 0.9, b: 0.5 });
    } else if (effect.kind === "tracer") {
      const t = state.tracers[state.nextTracer++ % state.tracers.length]!;
      Object.assign(t, { life: 0.09, max: 0.09, x0: effect.x, y0: 1.9, z0: effect.z, x1: effect.toX ?? effect.x, y1: 1.2, z1: effect.toZ ?? effect.z });
    } else if (effect.kind === "sparks") sparks(effect.x, 1.2, effect.z, 7, 7);
    else explode(effect.x, effect.z, effect.big === true);
  };

  const emitters = (cars: readonly CombatVehicleState[], tick: number, dt: number): void => {
    state.clock += dt;
    // Smoke from a hurt car thickens as it nears death; a wreck burns for a while, then smoulders.
    const cadence = state.clock % 0.05 < dt;
    for (const car of cars) {
      const fx = Math.sin(car.heading);
      const fz = Math.cos(car.heading);
      if (car.alive) {
        const fraction = car.health / car.maxHealth;
        if (fraction < 0.45 && cadence) {
          spawn(state.smoke, "smoke", { life: 0.9, x: car.x + fx * 1.4, y: 1.3, z: car.z + fz * 1.4, vx: (state.rand() - 0.5) * 0.8, vy: 2.2, vz: (state.rand() - 0.5) * 0.8, size: 0.35 + (0.45 - fraction) * 1.6, grow: 1.2, r: fraction < 0.25 ? 0.12 : 0.4, g: fraction < 0.25 ? 0.12 : 0.4, b: fraction < 0.25 ? 0.13 : 0.42 });
          if (fraction < 0.25) spawn(state.glow, "glow", { life: 0.3, x: car.x + fx * 1.2, y: 1.2, z: car.z + fz * 1.2, vy: 1.5, size: 0.3, grow: -0.8, r: 1, g: 0.4, b: 0.08 });
        }
        if (car.boost > 0) spawn(state.glow, "glow", { life: 0.18, x: car.x - fx * 2.3, y: 0.8, z: car.z - fz * 2.3, vx: -fx * 6, vz: -fz * 6, size: 0.45, grow: -1.4, r: 0.35, g: 0.7, b: 1 });
      } else if (car.wreckedTick !== null) {
        const age = (tick - car.wreckedTick) / TICK_RATE;
        if (age < WRECK_BURN_SECONDS) {
          spawn(state.glow, "glow", { life: 0.35, x: car.x + (state.rand() - 0.5) * 1.6, y: 0.8, z: car.z + (state.rand() - 0.5) * 2.4, vy: 2.5 + state.rand() * 1.5, size: 0.55 + state.rand() * 0.35, grow: -1, r: 1, g: 0.35 + state.rand() * 0.3, b: 0.05 });
          if (cadence) spawn(state.smoke, "smoke", { life: 1.6, x: car.x, y: 1.4, z: car.z, vx: (state.rand() - 0.5), vy: 2.6, vz: (state.rand() - 0.5), size: 0.8, grow: 1.8, r: 0.13, g: 0.13, b: 0.14 });
        } else if (cadence && state.rand() < 0.3) {
          spawn(state.smoke, "smoke", { life: 1.4, x: car.x, y: 1.2, z: car.z, vy: 1.6, size: 0.5, grow: 1, r: 0.3, g: 0.3, b: 0.32 });
        }
      }
    }
  };

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const snapshot = live.current;
    // A restart rewinds the clock: drop what was burning.
    if (snapshot.tick < state.lastTick) {
      for (const p of [...state.glow, ...state.smoke]) p.life = DEAD;
      for (const t of state.tracers) t.life = DEAD;
      state.bursts.length = 0;
      state.missiles.clear();
      state.shake = 0;
    }
    state.lastTick = snapshot.tick;

    const events = bus.current.events.splice(0);
    const placed: { x: number; z: number }[] = [];
    for (const effect of effectsFromEvents(events)) {
      emit(effect);
      if (effect.kind === "explosion") placed.push(effect);
    }
    state.shake = Math.max(state.shake, shakeFromEvents(events));

    // Missile trails, and a burst where a missile ended that no hit already announced.
    const flying = new Set<number>();
    for (const m of snapshot.missiles) {
      flying.add(m.id);
      state.missiles.set(m.id, { x: m.x, z: m.z });
      spawn(state.smoke, "smoke", { life: 0.7, x: m.x - Math.sin(m.heading) * 0.8, y: 1.3, z: m.z - Math.cos(m.heading) * 0.8, size: 0.28, grow: 1.5, r: 0.7, g: 0.7, b: 0.72 });
      spawn(state.glow, "glow", { life: 0.12, x: m.x - Math.sin(m.heading) * 0.6, y: 1.3, z: m.z - Math.cos(m.heading) * 0.6, size: 0.32, grow: -1.5, r: 1, g: 0.55, b: 0.15 });
    }
    for (const [id, at] of state.missiles) {
      if (flying.has(id)) continue;
      state.missiles.delete(id);
      if (snapshot.match.status === "running" && !placed.some((p) => Math.hypot(p.x - at.x, p.z - at.z) < 7)) explode(at.x, at.z, false);
    }
    emitters(snapshot.vehicles, snapshot.tick, dt);

    const glow = glowMesh.current;
    if (glow) {
      state.glow.forEach((p, i) => {
        if (p.life > DEAD) {
          p.life -= dt;
          p.vy -= p.gravity * dt;
          p.x += p.vx * dt; p.y = Math.max(0.05, p.y + p.vy * dt); p.z += p.vz * dt;
          p.size = Math.max(0, p.size + p.grow * dt);
        }
        if (p.life <= 0) { p.life = DEAD; dummy.position.set(0, -50, 0); dummy.scale.setScalar(0); }
        else {
          dummy.position.set(p.x, p.y, p.z);
          dummy.scale.setScalar(p.size);
          const f = Math.min(1, p.life / p.max * 1.6);
          glow.setColorAt(i, tint.setRGB(p.r * f, p.g * f, p.b * f));
        }
        dummy.updateMatrix();
        glow.setMatrixAt(i, dummy.matrix);
      });
      // Flash bursts reuse the same mesh: they take over the last slots for a few frames.
      state.bursts = state.bursts.filter((b) => (b.life -= dt) > 0);
      state.bursts.slice(0, 6).forEach((b, k) => {
        const i = GLOW_COUNT - 1 - k;
        const f = b.life / b.max;
        dummy.position.set(b.x, b.y, b.z);
        dummy.scale.setScalar(b.size * (1.1 - f * 0.5));
        dummy.updateMatrix();
        glow.setMatrixAt(i, dummy.matrix);
        glow.setColorAt(i, tint.setRGB(1 * f, 0.7 * f, 0.35 * f));
      });
      glow.instanceMatrix.needsUpdate = true;
      if (glow.instanceColor) glow.instanceColor.needsUpdate = true;
    }
    const smoke = smokeMesh.current;
    if (smoke) {
      state.smoke.forEach((p, i) => {
        if (p.life > DEAD) {
          p.life -= dt;
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
          p.vy *= 1 - 0.8 * dt;
          p.size = Math.max(0, p.size + p.grow * dt);
        }
        if (p.life <= 0) { p.life = DEAD; dummy.position.set(0, -50, 0); dummy.scale.setScalar(0); }
        else {
          dummy.position.set(p.x, p.y, p.z);
          // Smoke thins as it dies: shrink the last part of its life.
          dummy.scale.setScalar(p.size * Math.min(1, (p.life / p.max) * 3));
          smoke.setColorAt(i, tint.setRGB(p.r, p.g, p.b));
        }
        dummy.updateMatrix();
        smoke.setMatrixAt(i, dummy.matrix);
      });
      smoke.instanceMatrix.needsUpdate = true;
      if (smoke.instanceColor) smoke.instanceColor.needsUpdate = true;
    }
    const tracers = tracerMesh.current;
    if (tracers) {
      state.tracers.forEach((t, i) => {
        if (t.life > DEAD) t.life -= dt;
        if (t.life <= 0) { t.life = DEAD; dummy.position.set(0, -50, 0); dummy.scale.setScalar(0); dummy.quaternion.identity(); }
        else {
          dir.set(t.x1 - t.x0, t.y1 - t.y0, t.z1 - t.z0);
          const length = dir.length();
          dir.normalize();
          dummy.position.set((t.x0 + t.x1) / 2, (t.y0 + t.y1) / 2, (t.z0 + t.z1) / 2);
          dummy.quaternion.copy(quat.setFromUnitVectors(up, dir));
          const f = t.life / t.max;
          dummy.scale.set(0.07 * f + 0.02, 0.07 * f + 0.02, length);
        }
        dummy.updateMatrix();
        tracers.setMatrixAt(i, dummy.matrix);
      });
      dummy.quaternion.identity();
      tracers.instanceMatrix.needsUpdate = true;
    }

    // Camera jolt: a decaying random offset applied after the chase camera has placed the view.
    if (state.shake > 0.005) {
      camera.position.x += (state.rand() - 0.5) * state.shake;
      camera.position.y += (state.rand() - 0.5) * state.shake * 0.7;
      camera.position.z += (state.rand() - 0.5) * state.shake;
      state.shake *= Math.exp(-9 * dt);
    } else state.shake = 0;
  });

  return (
    <>
      <instancedMesh ref={glowMesh} args={[glowGeometry, glowMaterial, GLOW_COUNT]} frustumCulled={false} renderOrder={5} />
      <instancedMesh ref={smokeMesh} args={[glowGeometry, smokeMaterial, SMOKE_COUNT]} frustumCulled={false} renderOrder={4} />
      <instancedMesh ref={tracerMesh} args={[tracerGeometry, tracerMaterial, TRACER_COUNT]} frustumCulled={false} renderOrder={6} />
    </>
  );
}
