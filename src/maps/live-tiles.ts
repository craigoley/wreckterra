/**
 * Live tiles: fetches the OpenFreeMap z14 vector tiles around a picked point and decodes them into
 * typed features for `tile-city.ts`. OpenFreeMap serves OpenStreetMap data in the OpenMapTiles
 * schema with no API key; its terms ask for "© OpenMapTiles © OpenStreetMap contributors" on screen.
 * Tiles are fetched in parallel, each with a timeout and one retry.
 */
import { classifyRings, VectorTile, type VectorTileFeature } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import {
  tilePointToLonLat,
  tilesCovering,
  type LonLat,
  type TileCoord,
  type TileFeature,
  type TileLayerName,
  type TileRequest,
  type TileSet,
} from "./tile-city";

export const TILEJSON_URL = "https://tiles.openfreemap.org/planet";
export const TILE_TIMEOUT_MS = 8000;
export const TILE_RETRIES = 1;

export interface LiveTileOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  now?: () => Date;
  tileJsonUrl?: string;
}

const LAYERS: readonly TileLayerName[] = ["building", "transportation", "park", "landcover"];

async function fetchWithRetry(url: string, fetchImpl: typeof fetch, timeoutMs: number, retries: number): Promise<Response> {
  let lastError: unknown = new Error("no attempt was made");
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      // A tile that does not exist is an empty tile (open water), not a failure.
      if (response.ok || response.status === 404 || response.status === 204) return response;
      lastError = new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      lastError = controller.signal.aborted ? new Error(`timed out after ${timeoutMs} ms for ${url}`) : error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function gunzipIfNeeded(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Resolve the tile URL template and its version segment from OpenFreeMap's TileJSON. */
export async function readTileJson(url: string, fetchImpl: typeof fetch, timeoutMs: number, retries: number): Promise<{ template: string; version: string }> {
  const response = await fetchWithRetry(url, fetchImpl, timeoutMs, retries);
  if (!response.ok) throw new Error(`the tile index answered HTTP ${response.status}`);
  const json = (await response.json()) as { tiles?: unknown };
  const template = Array.isArray(json.tiles) ? json.tiles[0] : undefined;
  if (typeof template !== "string" || !template.includes("{z}") || !template.includes("{x}") || !template.includes("{y}")) {
    throw new Error("the tile index has no usable tile URL");
  }
  const version = /\/([^/]+)\/\{z\}/.exec(template)?.[1] ?? "unversioned";
  return { template, version };
}

/** Decode one tile's bytes into the features the city builder reads. */
export function decodeTile(bytes: Uint8Array, tile: TileCoord): TileFeature[] {
  const decoded = new VectorTile(new PbfReader(bytes));
  const features: TileFeature[] = [];
  for (const name of LAYERS) {
    const layer = decoded.layers[name];
    if (!layer) continue;
    for (let i = 0; i < layer.length; i += 1) {
      const feature: VectorTileFeature = layer.feature(i);
      const toLonLat = (ring: { x: number; y: number }[]): LonLat[] => ring.map((p) => tilePointToLonLat(tile, p.x, p.y, layer.extent));
      if (feature.type === 2 && name === "transportation") {
        features.push({ layer: name, geometry: "LineString", parts: feature.loadGeometry().map(toLonLat), properties: feature.properties });
      } else if (feature.type === 3 && name !== "transportation") {
        const polygons = classifyRings(feature.loadGeometry());
        features.push({
          layer: name,
          geometry: "Polygon",
          parts: polygons.map((polygon) => toLonLat(polygon[0]!)),
          properties: feature.properties,
          holes: polygons.reduce((sum, polygon) => sum + polygon.length - 1, 0),
        });
      }
    }
  }
  return features;
}

/** Fetch and decode every z14 tile covering the requested square. Rejects when any tile cannot be had. */
export async function fetchTileFeatures(request: TileRequest, options: LiveTileOptions = {}): Promise<TileSet> {
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? TILE_TIMEOUT_MS;
  const retries = options.retries ?? TILE_RETRIES;
  const tiles = tilesCovering(request.center, request.halfSizeM);
  const { template, version } = await readTileJson(options.tileJsonUrl ?? TILEJSON_URL, fetchImpl, timeoutMs, retries);
  const perTile = await Promise.all(tiles.map(async (tile) => {
    const url = template.replace("{z}", String(tile.z)).replace("{x}", String(tile.x)).replace("{y}", String(tile.y));
    const response = await fetchWithRetry(url, fetchImpl, timeoutMs, retries);
    if (!response.ok) return [];
    return decodeTile(await gunzipIfNeeded(new Uint8Array(await response.arrayBuffer())), tile);
  }));
  return {
    tileVersion: version,
    retrievedAt: (options.now ?? (() => new Date()))().toISOString(),
    tileUrl: template,
    features: perTile.flat(),
  };
}
