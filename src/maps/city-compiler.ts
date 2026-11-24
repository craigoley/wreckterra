/**
 * City compiler: turns a pinned OpenStreetMap (Overpass JSON) snapshot into the compact city file
 * the game loads. Pure and deterministic: the same snapshot yields the same bytes, with no clock,
 * no randomness beyond a seeded generator keyed on ids, and no network. Only erasable TypeScript is
 * used so `scripts/acquire-midtown.mjs` can import it directly under Node.
 *
 * Local coordinates are metres: x is east, z is south (so y-up three.js space is right-handed) and
 * the origin is the snapshot's stable origin. A vehicle heading h faces (sin h, cos h).
 */

export const CITY_VERSION = 1 as const;
/** Storey height used when a building only says how many levels it has. */
export const LEVEL_HEIGHT_M = 3.2;
/** Labelled fallback height for buildings with neither `height` nor `building:levels`. */
export const DEFAULT_BUILDING_HEIGHT_M = 15;
export const MAX_BUILDING_HEIGHT_M = 500;
export const SIDEWALK_WIDTH_M = 3.8;
const EARTH_RADIUS_M = 6371008.8;
const FOOT_M = 0.3048;

export type Vec2 = [number, number];
export type HeightSource = "height" | "levels" | "default";
export type SnapshotKind = "openstreetmap" | "synthetic-stand-in";

export interface SnapshotReceipt {
  kind: SnapshotKind;
  /** Where the snapshot came from; null for a stand-in that was never downloaded. */
  url: string | null;
  query?: string;
  retrievedAt: string;
  /** SHA-256 (hex) of `JSON.stringify(elements)`. */
  sha256: string;
  bbox: { south: number; west: number; north: number; east: number };
  origin: { lat: number; lon: number };
  note?: string;
}

export interface OsmNode { type: "node"; id: number; lat: number; lon: number; tags?: Record<string, string> }
export interface OsmWay { type: "way"; id: number; nodes: number[]; tags?: Record<string, string> }
export interface OsmSnapshot { wreckterra: SnapshotReceipt; elements: unknown[] }

export interface Building {
  id: number;
  /** Footprint ring in local metres, no repeated closing point, positive shoelace area in (x, z). */
  footprint: Vec2[];
  height: number;
  heightSource: HeightSource;
}
export interface Road {
  id: number;
  highway: string;
  name: string | null;
  width: number;
  lanes: number | null;
  oneway: boolean;
  /** Draw order: higher ranks are drawn last so major streets cover minor ones at junctions. */
  rank: number;
  points: Vec2[];
  nodeIds: number[];
}
export interface Sidewalk { roadId: number; side: 1 | -1; width: number; a: Vec2; b: Vec2 }
export interface Park { id: number; ring: Vec2[] }
export interface GraphNode { id: number; x: number; z: number }
/** A directed drivable edge between two graph node indices. */
export interface GraphEdge { from: number; to: number; length: number; roadId: number; width: number }
export interface Spawn { x: number; z: number; heading: number }
export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }
export interface RejectedWay { id: number; reason: string }

export interface CityData {
  version: typeof CITY_VERSION;
  source: SnapshotReceipt & { attribution: string; licence: string };
  origin: { lat: number; lon: number };
  bounds: Bounds;
  buildings: Building[];
  roads: Road[];
  sidewalks: Sidewalk[];
  parks: Park[];
  trees: Vec2[];
  lamps: Vec2[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  spawns: Spawn[];
  /** Ways dropped in `invalid: "skip"` mode; always empty in the default strict mode. */
  rejected: RejectedWay[];
}

export interface CompileOptions {
  /** `throw` (default) rejects the whole snapshot on bad geometry; `skip` drops the way and records it. */
  invalid?: "throw" | "skip";
  maxSpawns?: number;
}

export class CityCompileError extends Error {
  readonly elementId: number | null;
  constructor(message: string, elementId: number | null = null) {
    super(message);
    this.name = "CityCompileError";
    this.elementId = elementId;
  }
}

/* ---------------------------------------------------------------- geometry helpers */

const round2 = (v: number): number => Math.round(v * 100) / 100 + 0;
const round3 = (v: number): number => Math.round(v * 1000) / 1000 + 0;

function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
}

/** True when closed segments a-b and c-d share any point (crossing, touching or overlapping). */
export function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  return o4 === 0 && onSegment(c, d, b);
}

/** True when any two non-adjacent edges of the ring (closing edge implied) touch or cross. */
export function isSelfIntersecting(ring: readonly Vec2[]): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    for (let j = i + 1; j < n; j += 1) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(a, b, ring[j]!, ring[(j + 1) % n]!)) return true;
    }
  }
  return false;
}

/** Shoelace area over (x, z); positive for a counter-clockwise ring in that plane. */
export function signedArea(ring: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

export function pointInRing(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Closest point on segment a-b to p. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2));
  return [a[0] + dx * t, a[1] + dz * t];
}

function distanceToRing(p: Vec2, ring: readonly Vec2[]): number {
  if (pointInRing(p, ring)) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    const c = closestOnSegment(p, ring[i]!, ring[(i + 1) % ring.length]!);
    best = Math.min(best, Math.hypot(p[0] - c[0], p[1] - c[1]));
  }
  return best;
}

/** Equirectangular projection around the origin: x east, z south, in metres. */
export function project(lat: number, lon: number, origin: { lat: number; lon: number }): Vec2 {
  const rad = Math.PI / 180;
  const x = EARTH_RADIUS_M * Math.cos(origin.lat * rad) * (lon - origin.lon) * rad;
  const north = EARTH_RADIUS_M * (lat - origin.lat) * rad;
  return [round2(x), round2(-north)];
}

/** Small seeded generator (mulberry32), local so the compiler has no dependency on the sim. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------- tags */

/** Parse an OSM height value ("45", "45.5 m", "150 ft", "60'") into metres, or null if unusable. */
export function parseHeightMeters(value: string | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(m|meters?|metres?|ft|feet|')?\s*$/i.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "m").toLowerCase();
  const metres = unit === "ft" || unit === "feet" || unit === "'" ? amount * FOOT_M : amount;
  return Number.isFinite(metres) && metres > 0 && metres <= MAX_BUILDING_HEIGHT_M ? metres : null;
}

/** Building height: the `height` tag, else `building:levels` times the storey height, else a labelled default. */
export function buildingHeight(tags: Record<string, string> | undefined): { height: number; source: HeightSource } {
  const explicit = parseHeightMeters(tags?.height);
  if (explicit !== null) return { height: round2(explicit), source: "height" };
  const levelsText = tags?.["building:levels"];
  const levels = typeof levelsText === "string" && /^\s*\d+(\.\d+)?\s*$/.test(levelsText) ? Number(levelsText) : NaN;
  if (Number.isFinite(levels) && levels > 0 && levels * LEVEL_HEIGHT_M <= MAX_BUILDING_HEIGHT_M) {
    return { height: round2(levels * LEVEL_HEIGHT_M), source: "levels" };
  }
  return { height: DEFAULT_BUILDING_HEIGHT_M, source: "default" };
}

interface RoadClass { width: number; rank: number; sidewalks: boolean }
const ROAD_CLASSES: Record<string, RoadClass> = {
  motorway: { width: 16, rank: 6, sidewalks: false },
  trunk: { width: 15, rank: 6, sidewalks: false },
  primary: { width: 14, rank: 5, sidewalks: true },
  secondary: { width: 12, rank: 4, sidewalks: true },
  tertiary: { width: 10, rank: 3, sidewalks: true },
  residential: { width: 8.5, rank: 2, sidewalks: true },
  unclassified: { width: 8, rank: 2, sidewalks: true },
  living_street: { width: 6, rank: 1, sidewalks: true },
  service: { width: 5, rank: 0, sidewalks: false },
};

/** Carriageway width in metres from the highway class, overridden by an explicit lane count. */
export function roadWidth(highway: string, lanes: number | null): number {
  const base = ROAD_CLASSES[highway]?.width ?? 8;
  if (lanes === null) return base;
  return round2(Math.max(5, Math.min(24, lanes * 3.4)));
}

/* ---------------------------------------------------------------- compile */

function bad(options: CompileOptions, rejected: RejectedWay[], id: number, reason: string): void {
  if (options.invalid === "skip") rejected.push({ id, reason });
  else throw new CityCompileError(`way ${id}: ${reason}`, id);
}

function readNodes(elements: readonly unknown[]): Map<number, OsmNode> {
  const nodes = new Map<number, OsmNode>();
  for (const raw of elements) {
    const e = raw as Partial<OsmNode> | null;
    if (!e || typeof e !== "object" || e.type !== "node") continue;
    if (typeof e.id !== "number" || !Number.isFinite(e.id)) throw new CityCompileError("node without a finite id");
    if (typeof e.lat !== "number" || typeof e.lon !== "number" || !Number.isFinite(e.lat) || !Number.isFinite(e.lon)) {
      throw new CityCompileError(`node ${e.id}: non-finite coordinates`, e.id);
    }
    if (Math.abs(e.lat) > 90 || Math.abs(e.lon) > 180) throw new CityCompileError(`node ${e.id}: coordinates out of range`, e.id);
    nodes.set(e.id, e as OsmNode);
  }
  return nodes;
}

function readWays(elements: readonly unknown[]): OsmWay[] {
  const ways: OsmWay[] = [];
  for (const raw of elements) {
    const e = raw as Partial<OsmWay> | null;
    if (!e || typeof e !== "object" || e.type !== "way") continue;
    if (typeof e.id !== "number" || !Number.isFinite(e.id) || !Array.isArray(e.nodes)) throw new CityCompileError("malformed way");
    ways.push(e as OsmWay);
  }
  return ways.sort((a, b) => a.id - b.id);
}

function ringOf(way: OsmWay, nodes: Map<number, OsmNode>, origin: { lat: number; lon: number }): Vec2[] | string {
  if (way.nodes.length < 4 || way.nodes[0] !== way.nodes[way.nodes.length - 1]) return "not a closed ring";
  const ring: Vec2[] = [];
  for (const id of way.nodes.slice(0, -1)) {
    const node = nodes.get(id);
    if (!node) return `missing node ${id}`;
    ring.push(project(node.lat, node.lon, origin));
  }
  if (!ring.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) return "non-finite geometry";
  return ring;
}

function offsetSegment(a: Vec2, b: Vec2, offset: number): [Vec2, Vec2] | null {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return null;
  // Left normal in (x, z): rotate the direction a quarter turn.
  const nx = dz / len;
  const nz = -dx / len;
  return [[a[0] + nx * offset, a[1] + nz * offset], [b[0] + nx * offset, b[1] + nz * offset]];
}

export function compileCity(snapshot: OsmSnapshot, options: CompileOptions = {}): CityData {
  const receipt = snapshot?.wreckterra;
  if (!receipt || !Array.isArray(snapshot.elements)) throw new CityCompileError("snapshot has no receipt or elements");
  const origin = receipt.origin;
  if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lon)) throw new CityCompileError("snapshot origin is not finite");
  const rejected: RejectedWay[] = [];
  const nodes = readNodes(snapshot.elements);
  const ways = readWays(snapshot.elements);

  const buildings: Building[] = [];
  const parks: Park[] = [];
  const roads: Road[] = [];
  const trees: Vec2[] = [];

  for (const way of ways) {
    const tags = way.tags ?? {};
    if (tags.building && tags.building !== "no") {
      const ring = ringOf(way, nodes, origin);
      if (typeof ring === "string") { if (ring !== "not a closed ring") bad(options, rejected, way.id, ring); continue; }
      if (isSelfIntersecting(ring)) { bad(options, rejected, way.id, "self-intersecting footprint"); continue; }
      if (Math.abs(signedArea(ring)) < 1) { bad(options, rejected, way.id, "degenerate footprint"); continue; }
      const { height, source } = buildingHeight(tags);
      buildings.push({ id: way.id, footprint: signedArea(ring) > 0 ? ring : [...ring].reverse(), height, heightSource: source });
    } else if (tags.leisure === "park" || tags.leisure === "garden" || tags.landuse === "grass") {
      const ring = ringOf(way, nodes, origin);
      if (typeof ring === "string") { if (ring !== "not a closed ring") bad(options, rejected, way.id, ring); continue; }
      if (isSelfIntersecting(ring)) { bad(options, rejected, way.id, "self-intersecting park"); continue; }
      if (Math.abs(signedArea(ring)) < 1) { bad(options, rejected, way.id, "degenerate park"); continue; }
      parks.push({ id: way.id, ring: signedArea(ring) > 0 ? ring : [...ring].reverse() });
    } else if (tags.highway && ROAD_CLASSES[tags.highway]) {
      let ids = way.nodes.filter((id, i) => i === 0 || id !== way.nodes[i - 1]);
      const missing = ids.find((id) => !nodes.has(id));
      if (missing !== undefined) { bad(options, rejected, way.id, `missing node ${missing}`); continue; }
      if (ids.length < 2) continue;
      if (tags.oneway === "-1") ids = [...ids].reverse();
      const lanesNumber = Number(tags.lanes);
      const lanes = Number.isInteger(lanesNumber) && lanesNumber >= 1 && lanesNumber <= 8 ? lanesNumber : null;
      const klass = ROAD_CLASSES[tags.highway]!;
      roads.push({
        id: way.id,
        highway: tags.highway,
        name: tags.name ?? null,
        width: roadWidth(tags.highway, lanes),
        lanes,
        oneway: tags.oneway === "yes" || tags.oneway === "true" || tags.oneway === "1" || tags.oneway === "-1",
        rank: klass.rank,
        points: ids.map((id) => { const n = nodes.get(id)!; return project(n.lat, n.lon, origin); }),
        nodeIds: ids,
      });
    }
  }
  for (const node of [...nodes.values()].sort((a, b) => a.id - b.id)) {
    if (node.tags?.natural === "tree") trees.push(project(node.lat, node.lon, origin));
  }

  // Draw order: minor roads first so majors cover them; ties by id.
  roads.sort((a, b) => a.rank - b.rank || a.id - b.id);

  /* ---- street graph */
  const graphNodeIndex = new Map<number, number>();
  const graphNodes: GraphNode[] = [];
  for (const road of roads) {
    road.nodeIds.forEach((id, i) => {
      if (graphNodeIndex.has(id)) return;
      graphNodeIndex.set(id, graphNodes.length);
      graphNodes.push({ id, x: road.points[i]![0], z: road.points[i]![1] });
    });
  }
  const edges: GraphEdge[] = [];
  for (const road of roads) {
    for (let i = 0; i + 1 < road.points.length; i += 1) {
      const a = road.points[i]!;
      const b = road.points[i + 1]!;
      const length = round2(Math.hypot(b[0] - a[0], b[1] - a[1]));
      const from = graphNodeIndex.get(road.nodeIds[i]!)!;
      const to = graphNodeIndex.get(road.nodeIds[i + 1]!)!;
      edges.push({ from, to, length, roadId: road.id, width: road.width });
      if (!road.oneway) edges.push({ from: to, to: from, length, roadId: road.id, width: road.width });
    }
  }

  /* ---- sidewalks, trimmed where other roads cross so cross streets stay open */
  const waysAtNode = new Map<number, Road[]>();
  for (const road of roads) for (const id of new Set(road.nodeIds)) waysAtNode.set(id, [...(waysAtNode.get(id) ?? []), road]);
  const owns = (y: Road, x: Road): boolean => y.rank > x.rank || (y.rank === x.rank && y.id < x.id);
  const trimAt = (road: Road, nodeId: number): number => {
    let trim = 0;
    for (const other of waysAtNode.get(nodeId) ?? []) {
      if (other.id === road.id) continue;
      const sidewalks = ROAD_CLASSES[other.highway]!.sidewalks;
      trim = Math.max(trim, other.width / 2 + (owns(other, road) && sidewalks ? SIDEWALK_WIDTH_M : 0));
    }
    return trim;
  };
  const sidewalks: Sidewalk[] = [];
  const lamps: Vec2[] = [];
  for (const road of roads) {
    if (!ROAD_CLASSES[road.highway]!.sidewalks) continue;
    for (let i = 0; i + 1 < road.points.length; i += 1) {
      const a = road.points[i]!;
      const b = road.points[i + 1]!;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const t0 = trimAt(road, road.nodeIds[i]!);
      const t1 = trimAt(road, road.nodeIds[i + 1]!);
      if (length - t0 - t1 < 4) continue;
      const ux = (b[0] - a[0]) / length;
      const uz = (b[1] - a[1]) / length;
      const from: Vec2 = [a[0] + ux * t0, a[1] + uz * t0];
      const to: Vec2 = [b[0] - ux * t1, b[1] - uz * t1];
      for (const side of [1, -1] as const) {
        const seg = offsetSegment(from, to, side * (road.width / 2 + SIDEWALK_WIDTH_M / 2));
        if (!seg) continue;
        sidewalks.push({ roadId: road.id, side, width: SIDEWALK_WIDTH_M, a: [round2(seg[0][0]), round2(seg[0][1])], b: [round2(seg[1][0]), round2(seg[1][1])] });
        if (length - t0 - t1 >= 30 && side === 1) {
          const lamp = offsetSegment(from, to, side * (road.width / 2 + 0.7));
          if (lamp) lamps.push([round2((lamp[0][0] + lamp[1][0]) / 2), round2((lamp[0][1] + lamp[1][1]) / 2)]);
        }
      }
    }
  }

  /* ---- park trees, scattered with a generator keyed on the park id */
  for (const park of parks) {
    const rng = seeded(park.id);
    const xs = park.ring.map((p) => p[0]);
    const zs = park.ring.map((p) => p[1]);
    const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    const placed: Vec2[] = [];
    for (let attempt = 0; attempt < 600 && placed.length < 160; attempt += 1) {
      const p: Vec2 = [round2(minX + rng() * (maxX - minX)), round2(minZ + rng() * (maxZ - minZ))];
      if (!pointInRing(p, park.ring) || placed.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 9)) continue;
      placed.push(p);
    }
    trees.push(...placed);
  }

  /* ---- spawns: road midpoints clear of every footprint, spread out, nearest the origin first */
  const candidates = edges
    .filter((e) => e.length >= 40 && e.width >= 6)
    .map((e) => {
      const a = graphNodes[e.from]!;
      const b = graphNodes[e.to]!;
      const x = round2((a.x + b.x) / 2);
      const z = round2((a.z + b.z) / 2);
      return { x, z, heading: round3(Math.atan2(b.x - a.x, b.z - a.z)) };
    })
    .sort((p, q) => Math.hypot(p.x, p.z) - Math.hypot(q.x, q.z) || p.x - q.x || p.z - q.z || p.heading - q.heading);
  const spawns: Spawn[] = [];
  for (const c of candidates) {
    if (spawns.length >= (options.maxSpawns ?? 16)) break;
    if (spawns.some((s) => Math.hypot(s.x - c.x, s.z - c.z) < 30)) continue;
    if (buildings.some((b) => distanceToRing([c.x, c.z], b.footprint) < 5)) continue;
    spawns.push(c);
  }

  /* ---- bounds with a margin so the world edge is not visible at the last building */
  const all: Vec2[] = [...buildings.flatMap((b) => b.footprint), ...roads.flatMap((r) => r.points), ...parks.flatMap((p) => p.ring)];
  if (all.length === 0) throw new CityCompileError("snapshot has no buildings, roads or parks");
  const bounds: Bounds = {
    minX: round2(Math.min(...all.map((p) => p[0])) - 30),
    maxX: round2(Math.max(...all.map((p) => p[0])) + 30),
    minZ: round2(Math.min(...all.map((p) => p[1])) - 30),
    maxZ: round2(Math.max(...all.map((p) => p[1])) + 30),
  };

  const standIn = receipt.kind === "synthetic-stand-in";
  return {
    version: CITY_VERSION,
    source: {
      ...receipt,
      attribution: standIn ? "Stand-in layout in the OpenStreetMap data shape; not OpenStreetMap data" : "© OpenStreetMap contributors",
      licence: standIn ? "Original to this repository" : "Open Database Licence (ODbL) 1.0",
    },
    origin: { lat: origin.lat, lon: origin.lon },
    bounds,
    buildings,
    roads,
    sidewalks,
    parks,
    trees,
    lamps,
    graph: { nodes: graphNodes, edges },
    spawns,
    rejected,
  };
}

/** Stable serialisation: key order is fixed by construction, so equal cities give equal bytes. */
export function serializeCity(city: CityData): string {
  return `${JSON.stringify(city)}\n`;
}
