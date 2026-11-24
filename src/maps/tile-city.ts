/**
 * Tile city: turns decoded OpenStreetMap vector-tile features (OpenFreeMap, OpenMapTiles schema)
 * into the same `CityData` the pinned Midtown city uses, so the world, combat and render code
 * consume it unchanged.
 *
 * INVARIANT real-data-only: every building, road and park in a live city is a tile feature. Nothing
 * here generates stand-in geometry. When tiles cannot be fetched or hold no drivable roads the
 * outcome says so and offers the pinned city instead. The street graph, spawns and sidewalks are
 * derived from the real roads by `compileCity`; the scattered trees and lamps it would add are
 * dropped because no tile carries them.
 *
 * This file imports no tile decoder: `live-tiles.ts` owns pbf, and hands features in.
 */
import {
  CityCompileError,
  compileCity,
  project,
  type Bounds,
  type CityData,
  type OsmNode,
  type OsmSnapshot,
  type OsmWay,
  type SnapshotReceipt,
  type Spawn,
  type Vec2,
} from "./city-compiler";
import { cityCacheKey, readCachedCity, roundPoint, writeCachedCity, type CityStore, type LatLon } from "./city-cache";

export const TILE_ZOOM = 14;
/** Half the side of the square the live city covers, in metres (the city is about 700 m across). */
export const LIVE_HALF_SIZE_M = 350;
/** Beyond this latitude a 700 m square needs more than four z14 tiles, so the place is refused. */
export const MAX_LIVE_LATITUDE = 70;
export const OPENMAPTILES_ATTRIBUTION = "© OpenMapTiles © OpenStreetMap contributors";
export const OPENMAPTILES_LICENCE = "Open Database Licence (ODbL) 1.0 (map data); CC-BY 4.0 (OpenMapTiles schema)";
export const PINNED_FALLBACK = "pinned-midtown" as const;

const METRES_PER_DEGREE = 111_320;

/** [longitude, latitude] in degrees. */
export type LonLat = [number, number];

export type TileLayerName = "building" | "transportation" | "park" | "landcover";
export type TileProperties = Record<string, string | number | boolean>;

/** One decoded vector-tile feature. Polygons keep their outer rings only; lines keep each part. */
export interface TileFeature {
  layer: TileLayerName;
  geometry: "LineString" | "Polygon";
  parts: LonLat[][];
  properties: TileProperties;
  /** Interior rings (courtyards) the decoder saw and dropped from `parts`. */
  holes?: number;
}

export interface TileSet {
  /** The version segment of the tile URL; part of the cache key. */
  tileVersion: string;
  /** ISO timestamp of the fetch. */
  retrievedAt: string;
  /** The tile URL template the features came from. */
  tileUrl: string;
  features: TileFeature[];
}

export interface TileRequest { center: LatLon; halfSizeM: number }

export interface TileCityStats {
  buildings: number;
  roads: number;
  parks: number;
  /** Buildings whose height came from the labelled default rather than the tile. */
  defaultHeights: number;
  /** Ways `compileCity` dropped for bad geometry (non-finite or self-intersecting rings). */
  rejected: number;
  /** Building parts that start above ground (render_min_height > 0); the base building already covers them. */
  elevatedPartsSkipped: number;
  holesDropped: number;
  outsideSquare: number;
  duplicates: number;
}

export type TileCityResult =
  | { ok: true; city: CityData; stats: TileCityStats }
  | { ok: false; reason: string; stats: TileCityStats };

/* ---------------------------------------------------------------- tile math */

export interface TileCoord { z: number; x: number; y: number }

export function lonLatToTile(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

/** Longitude and latitude of a point inside tile (z, x, y); px and py are in 0..extent. */
export function tilePointToLonLat(tile: TileCoord, px: number, py: number, extent: number): LonLat {
  const n = 2 ** tile.z;
  const lon = ((tile.x + px / extent) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + py / extent)) / n))) * 180) / Math.PI;
  return [lon, lat];
}

/** The lat/lon box of the square around a point. */
export function squareBox(center: LatLon, halfSizeM: number): { south: number; north: number; west: number; east: number } {
  const dLat = halfSizeM / METRES_PER_DEGREE;
  const dLon = halfSizeM / (METRES_PER_DEGREE * Math.cos((center.lat * Math.PI) / 180));
  return { south: center.lat - dLat, north: center.lat + dLat, west: center.lon - dLon, east: center.lon + dLon };
}

/** The z14 tiles that cover the square around a point: at most four. */
export function tilesCovering(center: LatLon, halfSizeM: number = LIVE_HALF_SIZE_M, z: number = TILE_ZOOM): TileCoord[] {
  if (!Number.isFinite(center.lat) || !Number.isFinite(center.lon) || Math.abs(center.lat) > MAX_LIVE_LATITUDE || Math.abs(center.lon) > 180) {
    throw new RangeError("that place is outside the area live tiles can cover");
  }
  const box = squareBox(center, halfSizeM);
  const nw = lonLatToTile(box.north, box.west, z);
  const se = lonLatToTile(box.south, box.east, z);
  const tiles: TileCoord[] = [];
  for (let y = nw.y; y <= se.y; y += 1) for (let x = nw.x; x <= se.x; x += 1) tiles.push({ z, x, y });
  if (tiles.length > 4) throw new RangeError(`the square needs ${tiles.length} tiles; the limit is 4`);
  return tiles;
}

/* ---------------------------------------------------------------- hashing */

const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 of a string as lowercase hex. Synchronous and pure, so the city receipt needs no async crypto. */
export function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  const words = new Uint32Array((((data.length + 9 + 63) >> 6) << 4));
  for (let i = 0; i < data.length; i += 1) words[i >> 2] = words[i >> 2]! | (data[i]! << (24 - (i % 4) * 8));
  words[data.length >> 2] = words[data.length >> 2]! | (0x80 << (24 - (data.length % 4) * 8));
  words[words.length - 1] = (data.length * 8) >>> 0;
  words[words.length - 2] = Math.floor((data.length * 8) / 4294967296);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < words.length; block += 16) {
    for (let t = 0; t < 16; t += 1) w[t] = words[block + t]!;
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15]!, 7) ^ rotr(w[t - 15]!, 18) ^ (w[t - 15]! >>> 3);
      const s1 = rotr(w[t - 2]!, 17) ^ rotr(w[t - 2]!, 19) ^ (w[t - 2]! >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let t = 0; t < 64; t += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[t]! + w[t]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => { h[i] = (h[i]! + v) >>> 0; });
  }
  return h.map((v) => v.toString(16).padStart(8, "0")).join("");
}

/* ---------------------------------------------------------------- features to city */

/** OpenMapTiles transportation classes a car can drive, mapped to the highway names the compiler knows. */
const DRIVABLE_CLASSES: Record<string, string> = {
  motorway: "motorway",
  trunk: "trunk",
  primary: "primary",
  secondary: "secondary",
  tertiary: "tertiary",
  minor: "residential",
  service: "service",
};

const emptyStats = (): TileCityStats => ({
  buildings: 0, roads: 0, parks: 0, defaultHeights: 0, rejected: 0, elevatedPartsSkipped: 0, holesDropped: 0, outsideSquare: 0, duplicates: 0,
});

function numberOf(value: string | number | boolean | undefined): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert decoded tile features into a playable city around `center`. Pure and deterministic. A city
 * with no drivable road graph, or no spawn on it, is refused with a reason instead of being padded.
 */
export function buildTileCity(tiles: TileSet, center: LatLon, options: { halfSizeM?: number } = {}): TileCityResult {
  const half = options.halfSizeM ?? LIVE_HALF_SIZE_M;
  const stats = emptyStats();
  const refuse = (reason: string): TileCityResult => ({ ok: false, reason, stats });
  if (!Number.isFinite(center.lat) || !Number.isFinite(center.lon)) return refuse("The picked place has no usable coordinates.");

  const nodes: OsmNode[] = [];
  const ways: OsmWay[] = [];
  const nodeIds = new Map<string, number>();
  const seen = new Set<string>();
  const nodeFor = ([lon, lat]: LonLat): number => {
    const key = `${lat.toFixed(8)},${lon.toFixed(8)}`;
    let id = nodeIds.get(key);
    if (id === undefined) {
      id = nodes.length + 1;
      nodeIds.set(key, id);
      nodes.push({ type: "node", id, lat, lon });
    }
    return id;
  };
  const touchesSquare = (part: LonLat[]): boolean => {
    const local = part.map(([lon, lat]) => project(lat, lon, center));
    const xs = local.map((p) => p[0]);
    const zs = local.map((p) => p[1]);
    return Math.max(...xs) >= -half && Math.min(...xs) <= half && Math.max(...zs) >= -half && Math.min(...zs) <= half;
  };
  const addWay = (feature: TileFeature, part: LonLat[], tags: Record<string, string>, closed: boolean): boolean => {
    if (part.length < (closed ? 3 : 2) || !part.every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))) return false;
    const signature = `${feature.layer}|${part.map(([lon, lat]) => `${lon.toFixed(7)},${lat.toFixed(7)}`).join(";")}`;
    if (seen.has(signature)) { stats.duplicates += 1; return false; }
    seen.add(signature);
    if (!touchesSquare(part)) { stats.outsideSquare += 1; return false; }
    const ring = closed && (part[0]![0] !== part[part.length - 1]![0] || part[0]![1] !== part[part.length - 1]![1]) ? [...part, part[0]!] : part;
    ways.push({ type: "way", id: ways.length + 1, nodes: ring.map(nodeFor), tags });
    return true;
  };

  for (const feature of tiles.features) {
    stats.holesDropped += feature.holes ?? 0;
    const p = feature.properties;
    if (feature.layer === "building" && feature.geometry === "Polygon") {
      const minHeight = numberOf(p.render_min_height);
      if (minHeight !== null && minHeight > 0) { stats.elevatedPartsSkipped += feature.parts.length; continue; }
      const height = numberOf(p.render_height);
      const tags: Record<string, string> = { building: "yes" };
      if (height !== null && height > 0) tags.height = String(height);
      for (const part of feature.parts) addWay(feature, part, tags, true);
    } else if (feature.layer === "transportation" && feature.geometry === "LineString") {
      const highway = DRIVABLE_CLASSES[String(p.class)];
      if (!highway || p.brunnel === "tunnel") continue;
      const tags: Record<string, string> = { highway };
      const oneway = numberOf(p.oneway);
      if (oneway === 1) tags.oneway = "yes";
      if (oneway === -1) tags.oneway = "-1";
      for (const part of feature.parts) addWay(feature, part, tags, false);
    } else if ((feature.layer === "park" || (feature.layer === "landcover" && p.class === "grass")) && feature.geometry === "Polygon") {
      for (const part of feature.parts) addWay(feature, part, feature.layer === "park" ? { leisure: "park" } : { landuse: "grass" }, true);
    }
  }

  const box = squareBox(center, half);
  const receipt: SnapshotReceipt = {
    kind: "openstreetmap",
    url: tiles.tileUrl,
    retrievedAt: tiles.retrievedAt,
    sha256: sha256Hex(JSON.stringify(tiles.features)),
    bbox: box,
    origin: { lat: center.lat, lon: center.lon },
    note: `OpenFreeMap vector tiles, version ${tiles.tileVersion}, z${TILE_ZOOM}`,
  };
  const snapshot: OsmSnapshot = { wreckterra: receipt, elements: [...nodes, ...ways] };
  let compiled: CityData;
  try {
    compiled = compileCity(snapshot, { invalid: "skip", maxSpawns: 16 });
  } catch (error) {
    const detail = error instanceof CityCompileError ? error.message : error instanceof Error ? error.message : String(error);
    return refuse(`The map tiles for this place could not be turned into a city (${detail}).`);
  }
  stats.buildings = compiled.buildings.length;
  stats.roads = compiled.roads.length;
  stats.parks = compiled.parks.length;
  stats.defaultHeights = compiled.buildings.filter((b) => b.heightSource === "default").length;
  stats.rejected = compiled.rejected.length;

  if (compiled.roads.length === 0 || compiled.graph.edges.length === 0) {
    return refuse("The map tiles for this place hold no drivable roads, so there is nothing to play on.");
  }
  const bounds: Bounds = { minX: -half, maxX: half, minZ: -half, maxZ: half };
  const spawns: Spawn[] = compiled.spawns.filter((s) => s.x > bounds.minX && s.x < bounds.maxX && s.z > bounds.minZ && s.z < bounds.maxZ);
  if (spawns.length === 0) return refuse("The roads in the map tiles for this place leave no clear spot to start a car.");

  const city: CityData = {
    ...compiled,
    bounds,
    // The compiler scatters trees and lamps by rule; no tile carries them, so a live city has none.
    trees: [] as Vec2[],
    lamps: [] as Vec2[],
    spawns,
    source: { ...compiled.source, attribution: OPENMAPTILES_ATTRIBUTION, licence: OPENMAPTILES_LICENCE },
  };
  return { ok: true, city, stats };
}

/* ---------------------------------------------------------------- loading */

export interface LiveCityDeps {
  /** Fetch and decode the tiles for a request. Rejects when the network or the tiles fail. */
  fetchTiles(request: TileRequest): Promise<TileSet>;
  /** Where built cities are kept; omit for no caching. */
  cache?: CityStore;
}

export type LiveCityOutcome =
  | { ok: true; city: CityData; from: "cache" | "network"; stats: TileCityStats | null; notes: string[] }
  | { ok: false; reason: string; fallback: typeof PINNED_FALLBACK; notes: string[] };

/**
 * Load a live city for a picked point: from the device cache when one exists (no request is made),
 * otherwise from freshly fetched tiles, which are then cached. On any failure the outcome carries a
 * reason and offers the pinned city; it never carries generated geometry.
 */
export async function loadLiveCity(point: LatLon, deps: LiveCityDeps): Promise<LiveCityOutcome> {
  const notes: string[] = [];
  const fail = (reason: string): LiveCityOutcome => ({ ok: false, reason: `${reason} The pinned Midtown city is offered instead.`, fallback: PINNED_FALLBACK, notes });
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return fail("That place has no usable coordinates.");
  const center = roundPoint(point);
  const pointKey = cityCacheKey(center);

  if (deps.cache) {
    try {
      const hit = await readCachedCity(deps.cache, pointKey);
      if (hit) return { ok: true, city: hit.city, from: "cache", stats: null, notes };
    } catch (error) {
      notes.push(`The device cache could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let tiles: TileSet;
  try {
    tiles = await deps.fetchTiles({ center, halfSizeM: LIVE_HALF_SIZE_M });
  } catch (error) {
    return fail(`The live map tiles could not be fetched (${error instanceof Error ? error.message : String(error)}).`);
  }
  const built = buildTileCity(tiles, center);
  if (!built.ok) return fail(built.reason);

  if (deps.cache) {
    try {
      await writeCachedCity(deps.cache, pointKey, tiles.tileVersion, built.city);
    } catch (error) {
      notes.push(`The city could not be saved to the device cache: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: true, city: built.city, from: "network", stats: built.stats, notes };
}
