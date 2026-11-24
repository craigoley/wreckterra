import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { BufferGeometry, Color, DirectionalLight, Float32BufferAttribute, Group, InstancedMesh, Mesh, Object3D, ShapeUtils, Vector2 } from "three";
import type { Building, CityData, Road, Vec2 } from "../maps/city-compiler";
import { CITY_PAD_RADIUS } from "../sim/combat";
import type { CombatAuthority, CombatSnapshot } from "../sim/contracts";
import { CombatEffects, type EffectsBus } from "./CombatEffects";
import { ChaseCamera, type ChaseTarget } from "./ChaseCamera";
import { createCityMaterials, createSkyGeometry, FACADE_PALETTES, facadeVariant, GROUND_FLOOR_M, FLOOR_HEIGHT_M, HAZE, ROAD_TILE_M, TILE_WIDTH_M, type CityMaterials } from "./cityMaterials";
import type { Held } from "./TouchControls";

type V3 = [number, number, number];
type V2 = [number, number];

/** Collects flat-shaded triangles with explicit normals and UVs, then makes one merged geometry. */
class MeshBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private uvs: number[] = [];
  private indices: number[] = [];

  /** Add a quad; the winding is flipped as needed so the face points along `normal`. */
  quad(p: [V3, V3, V3, V3], uv: [V2, V2, V2, V2], normal: V3): void {
    const base = this.positions.length / 3;
    for (let i = 0; i < 4; i += 1) {
      this.positions.push(...p[i]!);
      this.normals.push(...normal);
      this.uvs.push(...uv[i]!);
    }
    const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
    const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
    const dot = (uy * vz - uz * vy) * normal[0] + (uz * vx - ux * vz) * normal[1] + (ux * vy - uy * vx) * normal[2];
    if (dot >= 0) this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else this.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  /** Add an upward-facing triangulated polygon at height y. UVs are world metres divided by `uvScale`. */
  polygon(ring: readonly Vec2[], y: number, uvScale: number): void {
    const triangles = ShapeUtils.triangulateShape(ring.map((p) => new Vector2(p[0], p[1])), []);
    const base = this.positions.length / 3;
    for (const p of ring) {
      this.positions.push(p[0], y, p[1]);
      this.normals.push(0, 1, 0);
      this.uvs.push(p[0] / uvScale, p[1] / uvScale);
    }
    for (const [a, b, c] of triangles as number[][]) {
      const pa = ring[a!]!, pb = ring[b!]!, pc = ring[c!]!;
      // Up-facing winding: the y component of (b - a) x (c - a) must be positive.
      const up = (pb[1] - pa[1]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[1] - pa[1]);
      if (up >= 0) this.indices.push(base + a!, base + b!, base + c!);
      else this.indices.push(base + a!, base + c!, base + b!);
    }
  }

  /** An axis-aligned box (all faces) between two heights. */
  box(cx: number, cz: number, hx: number, hz: number, y0: number, y1: number): void {
    const x0 = cx - hx, x1 = cx + hx, z0 = cz - hz, z1 = cz + hz;
    const z: V2 = [0, 0];
    const uv: [V2, V2, V2, V2] = [z, z, z, z];
    this.quad([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], uv, [0, 1, 0]);
    this.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], uv, [0, 0, 1]);
    this.quad([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], uv, [0, 0, -1]);
    this.quad([[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], uv, [1, 0, 0]);
    this.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], uv, [-1, 0, 0]);
  }

  get empty(): boolean {
    return this.indices.length === 0;
  }

  toGeometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("normal", new Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute("uv", new Float32BufferAttribute(this.uvs, 2));
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

export interface RoadGroup { lanes: number; oneway: boolean; geometry: BufferGeometry }
export interface CityGeometry {
  upper: (BufferGeometry | null)[];
  ground: (BufferGeometry | null)[];
  roof: (BufferGeometry | null)[];
  roads: RoadGroup[];
  junctions: BufferGeometry | null;
  sidewalks: BufferGeometry | null;
  parks: BufferGeometry | null;
  dispose(): void;
}

const PARAPET_M = 0.8;

function addBuilding(b: Building, upper: MeshBuilder, ground: MeshBuilder, roof: MeshBuilder): void {
  const ring = b.footprint;
  const height = b.height;
  const groundTop = Math.min(height, GROUND_FLOOR_M);
  let along = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const c = ring[(i + 1) % ring.length]!;
    const dx = c[0] - a[0];
    const dz = c[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const normal: V3 = [dz / len, 0, -dx / len];
    const u0 = along / TILE_WIDTH_M;
    const u1 = (along + len) / TILE_WIDTH_M;
    ground.quad([[a[0], 0, a[1]], [c[0], 0, c[1]], [c[0], groundTop, c[1]], [a[0], groundTop, a[1]]], [[u0, 0], [u1, 0], [u1, groundTop / GROUND_FLOOR_M], [u0, groundTop / GROUND_FLOOR_M]], normal);
    if (height > GROUND_FLOOR_M) {
      const v1 = (height - GROUND_FLOOR_M) / FLOOR_HEIGHT_M;
      upper.quad([[a[0], GROUND_FLOOR_M, a[1]], [c[0], GROUND_FLOOR_M, c[1]], [c[0], height, c[1]], [a[0], height, a[1]]], [[u0, 0], [u1, 0], [u1, v1], [u0, v1]], normal);
    }
    // Parapet cap around the roof edge.
    roof.quad([[a[0], height, a[1]], [c[0], height, c[1]], [c[0], height + PARAPET_M, c[1]], [a[0], height + PARAPET_M, a[1]]], [[0, 0], [0, 0], [0, 0], [0, 0]], normal);
    along += len;
  }
  roof.polygon(ring, height, 1);
  // A rooftop plant room on larger roofs, when the centre of the footprint is inside it.
  const xs = ring.map((p) => p[0]);
  const zs = ring.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const hx = Math.min(4, (Math.max(...xs) - Math.min(...xs)) * 0.18);
  const hz = Math.min(4, (Math.max(...zs) - Math.min(...zs)) * 0.18);
  const inside = [[cx - hx, cz - hz], [cx + hx, cz - hz], [cx + hx, cz + hz], [cx - hx, cz + hz]].every((p) => pointInRing(p as Vec2, ring));
  if (inside && hx > 1.2 && hz > 1.2) roof.box(cx, cz, hx, hz, height, height + 2.6 + (b.id % 3));
}

function pointInRing(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]!;
    const c = ring[j]!;
    if (a[1] > p[1] !== c[1] > p[1] && p[0] < ((c[0] - a[0]) * (p[1] - a[1])) / (c[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

const ROAD_Y = 0.02;
const CURB_M = 0.16;

function addRoad(road: Road, builder: MeshBuilder): void {
  let along = 0;
  for (let i = 0; i + 1 < road.points.length; i += 1) {
    const a = road.points[i]!;
    const c = road.points[i + 1]!;
    const dx = c[0] - a[0];
    const dz = c[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const nx = (dz / len) * (road.width / 2);
    const nz = (-dx / len) * (road.width / 2);
    const v0 = along / ROAD_TILE_M;
    const v1 = (along + len) / ROAD_TILE_M;
    builder.quad([[a[0] + nx, ROAD_Y, a[1] + nz], [c[0] + nx, ROAD_Y, c[1] + nz], [c[0] - nx, ROAD_Y, c[1] - nz], [a[0] - nx, ROAD_Y, a[1] - nz]], [[0, v0], [0, v1], [1, v1], [1, v0]], [0, 1, 0]);
    along += len;
  }
}

/** Plain asphalt over each junction so crossing lane markings do not run through it. */
function addJunctions(roads: readonly Road[], builder: MeshBuilder): void {
  const atNode = new Map<number, Road[]>();
  for (const road of roads) for (const id of new Set(road.nodeIds)) atNode.set(id, [...(atNode.get(id) ?? []), road]);
  for (const [nodeId, here] of [...atNode.entries()].sort((a, b) => a[0] - b[0])) {
    if (here.length < 2) continue;
    const owner = [...here].sort((a, b) => b.rank - a.rank || a.id - b.id)[0]!;
    const index = owner.nodeIds.indexOf(nodeId);
    const p = owner.points[index]!;
    const q = index + 1 < owner.points.length ? owner.points[index + 1]! : owner.points[index - 1]!;
    const dx = index + 1 < owner.points.length ? q[0] - p[0] : p[0] - q[0];
    const dz = index + 1 < owner.points.length ? q[1] - p[1] : p[1] - q[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const ux = dx / len, uz = dz / len;
    const along = Math.max(...here.filter((r) => r !== owner).map((r) => r.width)) / 2;
    const across = owner.width / 2;
    const corner = (s: number, t: number): V3 => [p[0] + ux * s * along + uz * t * across, ROAD_Y, p[1] + uz * s * along - ux * t * across];
    builder.quad([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], [[0, 0], [0, 0], [0, 0], [0, 0]], [0, 1, 0]);
  }
}

function addSidewalk(a: Vec2, c: Vec2, width: number, builder: MeshBuilder): void {
  const dx = c[0] - a[0];
  const dz = c[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return;
  const ux = dx / len, uz = dz / len;
  const nx = uz * (width / 2), nz = -ux * (width / 2);
  const left: V3 = [uz, 0, -ux];
  const right: V3 = [-uz, 0, ux];
  const top = (x: number, z: number): V3 => [x, CURB_M, z];
  const u1 = len / width;
  builder.quad([top(a[0] + nx, a[1] + nz), top(c[0] + nx, c[1] + nz), top(c[0] - nx, c[1] - nz), top(a[0] - nx, a[1] - nz)], [[0, 0], [u1, 0], [u1, 1], [0, 1]], [0, 1, 0]);
  builder.quad([[a[0] + nx, 0, a[1] + nz], [c[0] + nx, 0, c[1] + nz], [c[0] + nx, CURB_M, c[1] + nz], [a[0] + nx, CURB_M, a[1] + nz]], [[0, 0], [u1, 0], [u1, 0.05], [0, 0.05]], left);
  builder.quad([[a[0] - nx, 0, a[1] - nz], [c[0] - nx, 0, c[1] - nz], [c[0] - nx, CURB_M, c[1] - nz], [a[0] - nx, CURB_M, a[1] - nz]], [[0, 0], [u1, 0], [u1, 0.05], [0, 0.05]], right);
}

/** Merge the whole city into a handful of geometries: one per material, not one per building. */
export function buildCityGeometry(city: CityData): CityGeometry {
  const count = FACADE_PALETTES.length;
  const upper = Array.from({ length: count }, () => new MeshBuilder());
  const ground = Array.from({ length: count }, () => new MeshBuilder());
  const roof = Array.from({ length: count }, () => new MeshBuilder());
  for (const b of city.buildings) {
    const v = facadeVariant(b.id, count);
    addBuilding(b, upper[v]!, ground[v]!, roof[v]!);
  }
  const roadBuilders = new Map<string, { lanes: number; oneway: boolean; builder: MeshBuilder }>();
  for (const road of city.roads) {
    const lanes = Math.max(1, Math.min(8, Math.round(road.width / 3.4)));
    const key = `${lanes}-${road.oneway ? 1 : 0}`;
    let group = roadBuilders.get(key);
    if (!group) { group = { lanes, oneway: road.oneway, builder: new MeshBuilder() }; roadBuilders.set(key, group); }
    addRoad(road, group.builder);
  }
  const junctions = new MeshBuilder();
  addJunctions(city.roads, junctions);
  const sidewalks = new MeshBuilder();
  for (const s of city.sidewalks) addSidewalk(s.a, s.b, s.width, sidewalks);
  const parks = new MeshBuilder();
  for (const p of city.parks) parks.polygon(p.ring, 0.012, 8);
  const made = (b: MeshBuilder) => (b.empty ? null : b.toGeometry());
  const result: CityGeometry = {
    upper: upper.map(made),
    ground: ground.map(made),
    roof: roof.map(made),
    roads: [...roadBuilders.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, g]) => ({ lanes: g.lanes, oneway: g.oneway, geometry: g.builder.toGeometry() })),
    junctions: made(junctions),
    sidewalks: made(sidewalks),
    parks: made(parks),
    dispose() {
      for (const g of [...result.upper, ...result.ground, ...result.roof, ...result.roads.map((r) => r.geometry), result.junctions, result.sidewalks, result.parks]) g?.dispose();
    },
  };
  return result;
}

/* ---------------------------------------------------------------- instanced props */

function Instanced({ points, build, children }: { points: readonly Vec2[]; build: (i: number, p: Vec2, dummy: Object3D, color: Color) => void; children: React.ReactNode }) {
  const mesh = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const dummy = new Object3D();
    const color = new Color();
    points.forEach((p, i) => {
      dummy.position.set(0, 0, 0); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1);
      build(i, p, dummy, color);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      m.setColorAt(i, color);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [points, build]);
  if (points.length === 0) return null;
  return <instancedMesh ref={mesh} args={[undefined, undefined, points.length]} castShadow receiveShadow>{children}</instancedMesh>;
}

const placeTrunk = (_: number, p: Vec2, d: Object3D, c: Color) => { d.position.set(p[0], 1.1, p[1]); c.set("#5b4632"); };
const placeCanopy = (i: number, p: Vec2, d: Object3D, c: Color) => {
  const s = 0.8 + ((i * 37) % 11) / 18;
  d.position.set(p[0], 3.6 * s + 0.6, p[1]);
  d.scale.set(s, s * 0.9, s);
  c.setHSL(0.25 + (((i * 53) % 17) / 17) * 0.08, 0.45, 0.28 + (((i * 29) % 7) / 7) * 0.1);
};
const placePole = (_: number, p: Vec2, d: Object3D, c: Color) => { d.position.set(p[0], 3.4, p[1]); c.set("#3b4248"); };
const placeLamp = (_: number, p: Vec2, d: Object3D, c: Color) => { d.position.set(p[0], 6.9, p[1]); c.set("#ffe7a8"); };

/* ---------------------------------------------------------------- the city */

const CityMeshes = memo(function CityMeshes({ city, materials }: { city: CityData; materials: CityMaterials }) {
  const geometry = useMemo(() => buildCityGeometry(city), [city]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const { bounds } = city;
  const size = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) + 1600;
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[(bounds.minX + bounds.maxX) / 2, -0.1, (bounds.minZ + bounds.maxZ) / 2]} material={materials.base} receiveShadow dispose={null}>
        <planeGeometry args={[size, size]} />
      </mesh>
      {geometry.parks && <mesh geometry={geometry.parks} material={materials.grass} receiveShadow dispose={null} />}
      {geometry.roads.map((g) => <mesh key={`${g.lanes}-${g.oneway}`} geometry={g.geometry} material={materials.road(g.lanes, g.oneway)} receiveShadow dispose={null} />)}
      {geometry.junctions && <mesh geometry={geometry.junctions} material={materials.junction} receiveShadow dispose={null} />}
      {geometry.sidewalks && <mesh geometry={geometry.sidewalks} material={materials.sidewalk} receiveShadow castShadow dispose={null} />}
      {geometry.upper.map((g, i) => g && <mesh key={`u${i}`} geometry={g} material={materials.upper[i]} castShadow receiveShadow dispose={null} />)}
      {geometry.ground.map((g, i) => g && <mesh key={`g${i}`} geometry={g} material={materials.ground[i]} castShadow receiveShadow dispose={null} />)}
      {geometry.roof.map((g, i) => g && <mesh key={`r${i}`} geometry={g} material={materials.roof[i]} castShadow receiveShadow dispose={null} />)}
      <Instanced points={city.trees} build={placeTrunk}><cylinderGeometry args={[0.22, 0.32, 2.2, 6]} /><meshStandardMaterial roughness={1} /></Instanced>
      <Instanced points={city.trees} build={placeCanopy}><icosahedronGeometry args={[2.3, 1]} /><meshStandardMaterial roughness={0.95} flatShading /></Instanced>
      <Instanced points={city.lamps} build={placePole}><cylinderGeometry args={[0.07, 0.1, 6.8, 6]} /><meshStandardMaterial roughness={0.6} metalness={0.5} /></Instanced>
      <Instanced points={city.lamps} build={placeLamp}><boxGeometry args={[0.7, 0.18, 0.35]} /><meshStandardMaterial emissive="#ffd88a" emissiveIntensity={1.2} /></Instanced>
    </group>
  );
});

/* ---------------------------------------------------------------- the cars */

const DARK = "#1d2126";
const STEEL = "#8b949b";
const WHEELS: [number, number][] = [[-1.0, 1.45], [1.0, 1.45], [-1.0, -1.45], [1.0, -1.45]];

/**
 * An original combat car built from primitives: wedge nose, armoured flanks, roof machine gun and a
 * missile rack. Three builds share one chassis and differ in stance and kit: Voltage is low and
 * winged, Switchback is the balanced all-rounder, Rivet is a wide bruiser with a plough and plates.
 */
function CombatCar({ kind, color, accent }: { kind: string; color: string; accent: string }) {
  const scale: [number, number, number] = kind === "voltage" ? [0.92, 0.9, 1.04] : kind === "rivet" ? [1.18, 1.15, 1] : [1, 1, 1];
  return (
    <group scale={scale}>
      <mesh position={[0, 0.78, 0]} castShadow><boxGeometry args={[1.9, 0.55, 4.3]} /><meshStandardMaterial color={color} roughness={0.5} metalness={0.3} /></mesh>
      <mesh position={[0, 1.12, 1.2]} rotation-x={0.18} castShadow><boxGeometry args={[1.8, 0.28, 1.7]} /><meshStandardMaterial color={color} roughness={0.5} metalness={0.3} /></mesh>
      <mesh position={[0, 1.27, 1.15]} rotation-x={0.18}><boxGeometry args={[0.5, 0.04, 1.6]} /><meshStandardMaterial color={accent} roughness={0.4} /></mesh>
      <mesh position={[0, 1.4, -0.45]} castShadow><boxGeometry args={[1.55, 0.62, 1.9]} /><meshStandardMaterial color="#202c35" roughness={0.25} metalness={0.6} /></mesh>
      <mesh position={[-1.02, 0.85, 0]} castShadow><boxGeometry args={[0.16, 0.5, 3.2]} /><meshStandardMaterial color={STEEL} roughness={0.4} metalness={0.7} /></mesh>
      <mesh position={[1.02, 0.85, 0]} castShadow><boxGeometry args={[0.16, 0.5, 3.2]} /><meshStandardMaterial color={STEEL} roughness={0.4} metalness={0.7} /></mesh>
      <mesh position={[0, 0.62, 2.35]} castShadow><boxGeometry args={[2.05, 0.34, 0.45]} /><meshStandardMaterial color={DARK} roughness={0.5} metalness={0.6} /></mesh>
      {[-0.7, 0, 0.7].map((x) => <mesh key={x} position={[x, 0.62, 2.8]} rotation-x={Math.PI / 2} castShadow><coneGeometry args={[0.13, 0.5, 6]} /><meshStandardMaterial color={STEEL} metalness={0.8} roughness={0.3} /></mesh>)}
      <mesh position={[0, 1.88, -0.4]} castShadow><cylinderGeometry args={[0.32, 0.38, 0.28, 10]} /><meshStandardMaterial color={DARK} metalness={0.6} roughness={0.4} /></mesh>
      <mesh position={[0, 1.95, 0.45]} castShadow><boxGeometry args={[0.14, 0.14, 1.5]} /><meshStandardMaterial color={STEEL} metalness={0.8} roughness={0.3} /></mesh>
      {[-0.55, 0.55].map((x) => <mesh key={`m${x}`} position={[x, 1.78, -0.9]} rotation-x={Math.PI / 2} castShadow><cylinderGeometry args={[0.13, 0.13, 1.2, 8]} /><meshStandardMaterial color="#3a4249" metalness={0.7} roughness={0.35} /></mesh>)}
      {[-0.55, 0.55].map((x) => <mesh key={`n${x}`} position={[x, 1.78, -0.28]} rotation-x={Math.PI / 2}><coneGeometry args={[0.12, 0.3, 8]} /><meshStandardMaterial color="#c9ced2" metalness={0.5} roughness={0.4} /></mesh>)}
      <mesh position={[0, 2.12, -0.4]}><boxGeometry args={[0.22, 0.12, 0.22]} /><meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={1.6} /></mesh>
      <mesh position={[0, 1.5, -2.05]} castShadow><boxGeometry args={[kind === "voltage" ? 2.3 : 1.9, 0.1, 0.5]} /><meshStandardMaterial color={DARK} roughness={0.6} /></mesh>
      <mesh position={[0, 1.2, -1.95]}><boxGeometry args={[0.12, 0.6, 0.12]} /><meshStandardMaterial color={DARK} /></mesh>
      {kind === "voltage" && [-1.1, 1.1].map((x) => <mesh key={`f${x}`} position={[x, 1.6, -2.0]} castShadow><boxGeometry args={[0.08, 0.5, 0.7]} /><meshStandardMaterial color={accent} roughness={0.4} /></mesh>)}
      {kind === "rivet" && (
        <>
          <mesh position={[0, 0.9, 3.0]} rotation-x={-0.35} castShadow><boxGeometry args={[2.5, 0.8, 0.18]} /><meshStandardMaterial color={STEEL} metalness={0.8} roughness={0.35} /></mesh>
          <mesh position={[0, 1.78, 0.5]} castShadow><boxGeometry args={[1.7, 0.1, 1.2]} /><meshStandardMaterial color={DARK} metalness={0.6} roughness={0.4} /></mesh>
          {[-0.75, 0.75].map((x) => <mesh key={`e${x}`} position={[x, 1.7, -1.7]} castShadow><cylinderGeometry args={[0.1, 0.12, 0.9, 8]} /><meshStandardMaterial color="#555c61" metalness={0.8} roughness={0.4} /></mesh>)}
        </>
      )}
      {[-0.65, 0.65].map((x) => <mesh key={`h${x}`} position={[x, 0.85, 2.17]}><boxGeometry args={[0.4, 0.16, 0.06]} /><meshStandardMaterial color="#fff6d6" emissive="#fff0b3" emissiveIntensity={1.4} /></mesh>)}
      {[-0.7, 0.7].map((x) => <mesh key={`t${x}`} position={[x, 0.9, -2.17]}><boxGeometry args={[0.45, 0.14, 0.06]} /><meshStandardMaterial color="#aa1d1d" emissive="#ff2a2a" emissiveIntensity={0.9} /></mesh>)}
      {WHEELS.map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x * 1.02, 0.46, z]} rotation-z={Math.PI / 2} castShadow>
          <cylinderGeometry args={[0.47, 0.47, 0.38, 14]} /><meshStandardMaterial color="#15181b" roughness={0.9} />
        </mesh>
      ))}
      {WHEELS.map(([x, z]) => (
        <mesh key={`r${x}${z}`} position={[x * 1.12, 0.46, z]} rotation-z={Math.PI / 2}>
          <cylinderGeometry args={[0.26, 0.26, 0.4, 10]} /><meshStandardMaterial color={STEEL} metalness={0.8} roughness={0.3} />
        </mesh>
      ))}
    </group>
  );
}

/** What is left of a wrecked car: a charred, tilted shell the fire effects burn on. */
function Wreck() {
  return (
    <group rotation={[0.1, 0, 0.22]}>
      <mesh position={[0, 0.7, 0]}><boxGeometry args={[1.9, 0.6, 4.2]} /><meshStandardMaterial color="#17191b" roughness={1} /></mesh>
      <mesh position={[0.1, 1.2, -0.4]} rotation-z={0.15}><boxGeometry args={[1.5, 0.5, 1.8]} /><meshStandardMaterial color="#0f1112" roughness={1} /></mesh>
      <mesh position={[-0.5, 0.9, 1.5]} rotation-x={0.4}><boxGeometry args={[0.8, 0.12, 1.2]} /><meshStandardMaterial color="#2a1d14" roughness={1} /></mesh>
      {WHEELS.slice(0, 3).map(([x, z]) => <mesh key={`${x}${z}`} position={[x * 1.05, 0.4, z]} rotation-z={Math.PI / 2}><cylinderGeometry args={[0.45, 0.45, 0.36, 10]} /><meshStandardMaterial color="#0c0d0e" roughness={1} /></mesh>)}
    </group>
  );
}

/* ---------------------------------------------------------------- driving, light and quality */

export interface DriveControls { steer: number; throttle: number; brake: boolean }

/** Turn held buttons (and a gamepad, when no key is held) into drive input. */
export function readControls(held: Held, pad: { axes: readonly number[]; buttons: readonly { value?: number; pressed?: boolean }[] } | null | undefined): DriveControls {
  const keyed = (held.right ? 1 : 0) - (held.left ? 1 : 0);
  const drive = (held.gas ? 1 : 0) - (held.reverse ? 1 : 0);
  const steer = keyed !== 0 || !pad ? keyed : Math.abs(pad.axes[0] ?? 0) > 0.15 ? pad.axes[0]! : 0;
  const throttle = drive !== 0 || !pad ? drive : (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
  return { steer: Math.max(-1, Math.min(1, steer)), throttle: Math.max(-1, Math.min(1, throttle)), brake: held.brake || Boolean(pad?.buttons[3]?.pressed) };
}

/** The newest simulation state, read once per frame so every part of the scene sees the same instant. */
function Hub({ match, live, pose }: { match: CombatAuthority; live: MutableRefObject<CombatSnapshot>; pose: MutableRefObject<ChaseTarget> }) {
  useFrame(() => {
    const snapshot = match.snapshot();
    live.current = snapshot;
    const car = snapshot.vehicles[0]!;
    pose.current = { x: car.x, z: car.z, heading: car.heading, speed: car.speed };
  }, -3);
  return null;
}

export interface FleetEntry { id: string; kind: string; bot: boolean }

function Fighter({ live, entry, color }: { live: MutableRefObject<CombatSnapshot>; entry: FleetEntry; color: string }) {
  const root = useRef<Group>(null);
  const body = useRef<Group>(null);
  const intact = useRef<Group>(null);
  const wreck = useRef<Group>(null);
  const flash = useRef<Mesh>(null);
  const bar = useRef<Group>(null);
  const fill = useRef<Mesh>(null);
  useFrame(({ camera }) => {
    const snapshot = live.current;
    const car = snapshot.vehicles.find((v) => v.playerId === entry.id);
    const r = root.current;
    const b = body.current;
    if (!car || !r || !b) return;
    r.position.set(car.x, 0, car.z);
    b.rotation.set(0, car.heading, 0);
    b.position.y = car.airborne > 0 ? 0.9 : 0;
    if (intact.current) intact.current.visible = car.alive;
    if (wreck.current) wreck.current.visible = !car.alive;
    if (flash.current) flash.current.visible = car.alive && snapshot.tick - car.lastHitTick < 5;
    const g = bar.current;
    if (g) {
      g.visible = car.alive && entry.bot;
      g.quaternion.copy(camera.quaternion);
    }
    if (fill.current) {
      const f = Math.max(0.001, car.health / car.maxHealth);
      fill.current.scale.x = f;
      fill.current.position.x = -(1 - f) * 1.2;
    }
  });
  return (
    <group ref={root}>
      <group ref={body}>
        <group ref={intact}>
          <CombatCar kind={entry.kind} color={color} accent={entry.bot ? "#e0442f" : "#35b6ff"} />
          <mesh ref={flash} position={[0, 1.1, 0]} visible={false}>
            <boxGeometry args={[2.3, 1.7, 4.8]} /><meshBasicMaterial color="#ffffff" transparent opacity={0.55} depthWrite={false} />
          </mesh>
        </group>
        <group ref={wreck} visible={false}><Wreck /></group>
      </group>
      <group ref={bar} position={[0, 3.9, 0]}>
        <mesh><planeGeometry args={[2.5, 0.28]} /><meshBasicMaterial color="#1a1210" transparent opacity={0.75} depthTest={false} /></mesh>
        <mesh ref={fill} position={[0, 0, 0.01]}><planeGeometry args={[2.4, 0.18]} /><meshBasicMaterial color="#e8553f" depthTest={false} /></mesh>
      </group>
    </group>
  );
}

const MISSILE_SLOTS = 8;

/** Missiles in flight: a slim body with a hot nose, one mesh per slot, parked out of sight when unused. */
function Missiles({ live }: { live: MutableRefObject<CombatSnapshot> }) {
  const slots = useRef<(Group | null)[]>([]);
  useFrame(() => {
    const flying = live.current.missiles;
    for (let i = 0; i < MISSILE_SLOTS; i += 1) {
      const slot = slots.current[i];
      const m = flying[i];
      if (!slot) continue;
      slot.visible = m !== undefined;
      if (m) { slot.position.set(m.x, 1.3, m.z); slot.rotation.set(0, m.heading, 0); }
    }
  });
  return (
    <>
      {Array.from({ length: MISSILE_SLOTS }, (_, i) => (
        <group key={i} ref={(g) => { slots.current[i] = g; }} visible={false}>
          <mesh rotation-x={Math.PI / 2}><cylinderGeometry args={[0.14, 0.14, 1.5, 8]} /><meshStandardMaterial color="#e9edf0" metalness={0.4} roughness={0.4} /></mesh>
          <mesh position={[0, 0, 0.9]} rotation-x={Math.PI / 2}><coneGeometry args={[0.14, 0.4, 8]} /><meshStandardMaterial color="#d8412f" emissive="#d8412f" emissiveIntensity={0.8} /></mesh>
          <mesh position={[0, 0, -0.85]}><sphereGeometry args={[0.2, 6, 4]} /><meshBasicMaterial color="#ffb347" /></mesh>
        </group>
      ))}
    </>
  );
}

/** Pickup pads: a glowing ring on the road and a spinning icon, dimmed while the pad recharges. */
function Pickups({ match, live }: { match: CombatAuthority; live: MutableRefObject<CombatSnapshot> }) {
  const pads = match.layout.pads;
  const icons = useRef<(Group | null)[]>([]);
  const rings = useRef<(Mesh | null)[]>([]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    pads.forEach((pad, i) => {
      const ready = live.current.pickups.find((p) => p.id === pad.id)?.ready ?? true;
      const icon = icons.current[i];
      const ring = rings.current[i];
      if (icon) { icon.visible = ready; icon.rotation.y = t * 1.6; icon.position.y = 2.2 + Math.sin(t * 2.4 + i) * 0.25; }
      if (ring) { ring.scale.setScalar(ready ? 1 + Math.sin(t * 3 + i) * 0.04 : 0.85); (ring.material as { opacity: number }).opacity = ready ? 0.85 : 0.2; }
    });
  });
  return (
    <>
      {pads.map((pad, i) => {
        const health = pad.kind === "health";
        const tone = health ? "#53e08a" : "#ffb340";
        return (
          <group key={pad.id} position={[pad.x, 0, pad.z]}>
            <mesh ref={(m) => { rings.current[i] = m; }} rotation-x={-Math.PI / 2} position={[0, 0.12, 0]}>
              <ringGeometry args={[CITY_PAD_RADIUS - 0.5, CITY_PAD_RADIUS, 40]} /><meshBasicMaterial color={tone} transparent opacity={0.85} depthWrite={false} />
            </mesh>
            <group ref={(g) => { icons.current[i] = g; }} position={[0, 2.2, 0]}>
              {health ? (
                <>
                  <mesh><boxGeometry args={[1.5, 0.45, 0.45]} /><meshBasicMaterial color={tone} /></mesh>
                  <mesh><boxGeometry args={[0.45, 1.5, 0.45]} /><meshBasicMaterial color={tone} /></mesh>
                </>
              ) : (
                <>
                  <mesh><boxGeometry args={[0.8, 0.8, 0.8]} /><meshBasicMaterial color={tone} /></mesh>
                  <mesh position={[0, 0.75, 0]}><coneGeometry args={[0.45, 0.8, 4]} /><meshBasicMaterial color="#fff3d1" /></mesh>
                </>
              )}
            </group>
          </group>
        );
      })}
    </>
  );
}

/** The missile lock: a red ring that follows the locked car, so the lock is obvious in the street. */
function LockReticle({ live }: { live: MutableRefObject<CombatSnapshot> }) {
  const ring = useRef<Mesh>(null);
  useFrame(({ camera, clock }) => {
    const r = ring.current;
    if (!r) return;
    const snapshot = live.current;
    const me = snapshot.vehicles[0]!;
    const target = me.alive && me.lockId ? snapshot.vehicles.find((v) => v.playerId === me.lockId && v.alive) : undefined;
    r.visible = target !== undefined;
    if (!target) return;
    r.position.set(target.x, 1.6, target.z);
    r.quaternion.copy(camera.quaternion);
    r.rotateZ(clock.elapsedTime * 2);
    r.scale.setScalar(1 + Math.sin(clock.elapsedTime * 10) * 0.08);
  });
  return <mesh ref={ring} visible={false} renderOrder={7}><torusGeometry args={[2.6, 0.1, 6, 4]} /><meshBasicMaterial color="#ff3b2e" depthTest={false} transparent opacity={0.95} /></mesh>;
}

/** The sun follows the car so one small, sharp shadow map covers what is on screen. */
function Sun({ pose, shadowSize }: { pose: RefObject<ChaseTarget>; shadowSize: number }) {
  const light = useRef<DirectionalLight>(null);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const l = light.current;
    if (!l) return;
    scene.add(l.target);
    return () => { scene.remove(l.target); };
  }, [scene, shadowSize]);
  useFrame(() => {
    const l = light.current;
    const p = pose.current;
    if (!l || !p) return;
    l.position.set(p.x + 45, 80, p.z + 30);
    l.target.position.set(p.x, 0, p.z);
    l.target.updateMatrixWorld();
  }, -1);
  return (
    <directionalLight key={shadowSize} ref={light} intensity={2.4} color="#fff1d6" castShadow={shadowSize > 0}
      shadow-mapSize={[Math.max(1, shadowSize), Math.max(1, shadowSize)]} shadow-camera-left={-70} shadow-camera-right={70}
      shadow-camera-top={70} shadow-camera-bottom={-70} shadow-camera-near={1} shadow-camera-far={240} shadow-bias={-0.0004} shadow-normalBias={0.05} />
  );
}

function SkyDome({ materials }: { materials: CityMaterials }) {
  const geometry = useMemo(createSkyGeometry, []);
  const mesh = useRef<Mesh>(null);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useFrame((state) => { mesh.current?.position.copy(state.camera.position); });
  return <mesh ref={mesh} geometry={geometry} material={materials.sky} renderOrder={-10} frustumCulled={false} dispose={null} />;
}

export interface QualityLevel { scale: number; shadow: number }
/** From cheapest to richest: render resolution scale and shadow map size. Physics never changes. */
export const QUALITY_LEVELS: readonly QualityLevel[] = [
  { scale: 0.55, shadow: 0 },
  { scale: 0.75, shadow: 512 },
  { scale: 1, shadow: 1024 },
  { scale: 1.25, shadow: 2048 },
];

/** Decide the next quality level from a window of frame times (seconds). */
export function nextQuality(level: number, averageFrame: number, goodWindows: number): { level: number; goodWindows: number } {
  if (averageFrame > 1 / 38 && level > 0) return { level: level - 1, goodWindows: 0 };
  if (averageFrame < 1 / 55) {
    if (goodWindows + 1 >= 3 && level < QUALITY_LEVELS.length - 1) return { level: level + 1, goodWindows: 0 };
    return { level, goodWindows: goodWindows + 1 };
  }
  return { level, goodWindows: 0 };
}

function QualityGovernor({ level, onLevel }: { level: number; onLevel: (level: number) => void }) {
  const setDpr = useThree((s) => s.setDpr);
  const frames = useRef({ n: 0, sum: 0, warm: 0, good: 0, level });
  frames.current.level = level;
  useEffect(() => {
    const device = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    setDpr(Math.max(0.5, Math.min(2, device) * QUALITY_LEVELS[level]!.scale));
  }, [level, setDpr]);
  useFrame((_, delta) => {
    const f = frames.current;
    if (f.warm < 90) { f.warm += 1; return; } // shaders compile on the first frames
    f.n += 1;
    f.sum += Math.min(delta, 0.25);
    if (f.n < 60) return;
    const next = nextQuality(f.level, f.sum / f.n, f.good);
    f.n = 0; f.sum = 0; f.good = next.goodWindows;
    if (next.level !== f.level) { f.level = next.level; onLevel(next.level); }
  });
  return null;
}

/* ---------------------------------------------------------------- the scene */

function Attribution({ source }: { source: CityData["source"] }) {
  const real = source.kind === "openstreetmap";
  return (
    <p className="osm-attribution" style={{ position: "absolute", right: 6, bottom: 4, margin: 0, padding: "2px 8px", fontSize: 11, color: "#fff", background: "rgba(0,0,0,0.55)", borderRadius: 4 }}>
      {real ? "Map data " : "Stand-in street layout; real map data will be "}
      © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors
      {" "}(<a href="https://opendatacommons.org/licenses/odbl/" target="_blank" rel="noreferrer">ODbL</a>)
    </p>
  );
}

export interface CitySceneProps {
  city: CityData;
  match: CombatAuthority;
  /** Simulation events on their way to the effects. */
  bus: MutableRefObject<EffectsBus>;
  /** Body colour by vehicle kind. */
  colors: Record<string, string>;
  maxSpeed: number;
}

/** The real-city combat view: merged city meshes, the fighters, pickups, missiles and effects, a chase camera and OpenStreetMap attribution. */
export function CityScene({ city, match, bus, colors, maxSpeed }: CitySceneProps) {
  const coarse = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  const [level, setLevel] = useState(coarse ? 1 : 2);
  const [lost, setLost] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const start = match.snapshot().vehicles[0]!;
  const pose = useRef<ChaseTarget>({ x: start.x, z: start.z, heading: start.heading, speed: 0 });
  const live = useRef<CombatSnapshot>(match.snapshot());
  const fleet = useMemo<FleetEntry[]>(() => match.snapshot().vehicles.map((v) => ({ id: v.playerId, kind: v.kind, bot: v.bot })), [match]);
  const materials = useMemo(() => createCityMaterials(), []);
  useEffect(() => () => materials.dispose(), [materials]);
  return (
    <div className="city-stage" style={{ position: "absolute", inset: 0 }}>
      {lost
        ? <p role="status" className="city-lost" style={{ margin: 0, padding: "1rem", color: "#26323d" }}>The graphics context was lost. Recovering the view…</p>
        : (
          <Canvas key={epoch} shadows camera={{ fov: 62, near: 0.5, far: 1100, position: [start.x, 5, start.z - 9] }}
            gl={{ antialias: false, powerPreference: "high-performance", alpha: false }} style={{ touchAction: "none" }}
            onCreated={({ gl }) => {
              gl.domElement.addEventListener("webglcontextlost", (event) => { event.preventDefault(); setLost(true); });
              gl.domElement.addEventListener("webglcontextrestored", () => { setLost(false); setEpoch((n) => n + 1); });
            }}>
            <color attach="background" args={[HAZE]} />
            <fog attach="fog" args={[HAZE, 140, 560]} />
            <hemisphereLight args={["#bcd2ee", "#6b6a5f", 1.1]} />
            <Sun pose={pose} shadowSize={QUALITY_LEVELS[level]!.shadow} />
            <SkyDome materials={materials} />
            <CityMeshes city={city} materials={materials} />
            <Hub match={match} live={live} pose={pose} />
            {fleet.map((entry) => <Fighter key={entry.id} live={live} entry={entry} color={colors[entry.kind] ?? "#cccccc"} />)}
            <Pickups match={match} live={live} />
            <Missiles live={live} />
            <LockReticle live={live} />
            <ChaseCamera car={pose} maxSpeed={maxSpeed} />
            <CombatEffects live={live} bus={bus} />
            <QualityGovernor level={level} onLevel={setLevel} />
          </Canvas>
        )}
      <Attribution source={city.source} />
    </div>
  );
}
