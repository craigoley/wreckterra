import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cityCacheKey, createIndexedDbStore, createMemoryStore, roundPoint, type CityStore } from "../../src/maps/city-cache";
import { DEFAULT_BUILDING_HEIGHT_M, parseHeightMeters, project, type CityData, type OsmNode, type OsmWay, type Vec2 } from "../../src/maps/city-compiler";
import { loadPlayableCity, parseCity } from "../../src/maps/midtown";
import {
  buildTileCity,
  loadLiveCity,
  OPENMAPTILES_ATTRIBUTION,
  sha256Hex,
  tilesCovering,
  type LonLat,
  type TileFeature,
  type TileSet,
} from "../../src/maps/tile-city";

/**
 * Tile features for these tests are real OpenStreetMap geometry: the pinned Midtown extract re-shaped
 * into decoded-tile features (OpenMapTiles layers and properties). The committed capture straight from
 * OpenFreeMap needs network access the build sandbox lacks, so this stands in until it is recorded.
 */
const dir = resolve(__dirname, "../../public/maps/midtown");
const source = JSON.parse(readFileSync(resolve(dir, "source.osm.json"), "utf8")) as { elements: (OsmNode | OsmWay)[] };
const pinnedCity = parseCity(JSON.parse(readFileSync(resolve(dir, "city.json"), "utf8")));
const MIDTOWN = { lat: 40.76435, lon: -73.973 };

const OSM_TO_CLASS: Record<string, string> = {
  motorway: "motorway", trunk: "trunk", primary: "primary", secondary: "secondary", tertiary: "tertiary",
  residential: "minor", unclassified: "minor", living_street: "minor", service: "service",
};

function midtownFeatures(): TileFeature[] {
  const nodes = new Map<number, OsmNode>();
  for (const e of source.elements) if (e.type === "node") nodes.set(e.id, e);
  const features: TileFeature[] = [];
  for (const e of source.elements) {
    if (e.type !== "way") continue;
    const line: LonLat[] = e.nodes.map((id) => [nodes.get(id)!.lon, nodes.get(id)!.lat]);
    const tags = e.tags ?? {};
    if (tags.building) {
      const explicit = parseHeightMeters(tags.height);
      const levels = Number(tags["building:levels"]);
      const properties: TileFeature["properties"] = {};
      if (explicit !== null) properties.render_height = explicit;
      else if (Number.isFinite(levels) && levels > 0) properties.render_height = levels * 3;
      features.push({ layer: "building", geometry: "Polygon", parts: [line], properties });
    } else if (tags.leisure === "park") {
      features.push({ layer: "park", geometry: "Polygon", parts: [line], properties: {} });
    } else if (tags.highway && OSM_TO_CLASS[tags.highway]) {
      features.push({ layer: "transportation", geometry: "LineString", parts: [line], properties: { class: OSM_TO_CLASS[tags.highway]! } });
    }
  }
  return features;
}

const tileSet = (features: TileFeature[]): TileSet => ({
  tileVersion: "20261124_000000_pt",
  retrievedAt: "2026-11-24T00:00:00.000Z",
  tileUrl: "https://tiles.openfreemap.org/planet/20261124_000000_pt/{z}/{x}/{y}.pbf",
  features,
});

const center = roundPoint(MIDTOWN);
const ringKey = (ring: readonly Vec2[]): string => ring.map((p) => `${p[0]},${p[1]}`).sort().join("|");
const projectedKey = (part: LonLat[]): string => {
  const ring = part.slice(0, -1).map(([lon, lat]) => project(lat, lon, center));
  return ringKey(ring);
};
const lineKey = (part: LonLat[]): string => part.map(([lon, lat]) => project(lat, lon, center).join(",")).join("|");

const roadFeature = (points: LonLat[]): TileFeature => ({ layer: "transportation", geometry: "LineString", parts: [points], properties: { class: "tertiary" } });
/** A square ring of the given half side, centred this many metres north of the picked point. */
const boxAround = (half: number, northM = 0): LonLat[] => {
  const d = half / 111_320;
  const dl = d / Math.cos((center.lat * Math.PI) / 180);
  const lat = center.lat + northM / 111_320;
  return [[center.lon - dl, lat - d], [center.lon + dl, lat - d], [center.lon + dl, lat + d], [center.lon - dl, lat + d], [center.lon - dl, lat - d]];
};
/** A single real-shaped street through the centre so a city can be built from a hand-picked feature list. */
const street = (): TileFeature => roadFeature([[center.lon - 0.002, center.lat], [center.lon + 0.002, center.lat]]);

describe("tile city", () => {
  it("WRECK-T14: a live city uses only tile features and a failed fetch falls back to the pinned city", async () => {
    const features = midtownFeatures();
    expect(features.filter((f) => f.layer === "building").length).toBeGreaterThan(50);
    const outcome = await loadLiveCity(MIDTOWN, { fetchTiles: async () => tileSet(features) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const city = outcome.city;
    expect(outcome.from).toBe("network");
    expect(city.source.attribution).toBe(OPENMAPTILES_ATTRIBUTION);

    // Every building and road is a tile feature, vertex for vertex.
    const buildingKeys = new Set(features.filter((f) => f.layer === "building").map((f) => projectedKey(f.parts[0]!)));
    expect(city.buildings.length).toBeGreaterThan(50);
    for (const b of city.buildings) expect(buildingKeys.has(ringKey(b.footprint))).toBe(true);
    const lineKeys = new Set(features.filter((f) => f.layer === "transportation").map((f) => lineKey(f.parts[0]!)));
    expect(city.roads.length).toBeGreaterThan(10);
    for (const r of city.roads) expect(lineKeys.has(r.points.map((p) => p.join(",")).join("|"))).toBe(true);
    const parkKeys = new Set(features.filter((f) => f.layer === "park").map((f) => projectedKey(f.parts[0]!)));
    for (const p of city.parks) expect(parkKeys.has(ringKey(p.ring))).toBe(true);
    // Nothing is scattered: no trees or lamps without a tile feature behind them.
    expect(city.trees).toEqual([]);
    expect(city.lamps).toEqual([]);
    expect(city.spawns.length).toBeGreaterThan(0);

    // A city with only roads has only roads: it is never padded with filler buildings.
    const roadsOnly = buildTileCity(tileSet([street()]), center);
    expect(roadsOnly.ok).toBe(true);
    if (roadsOnly.ok) {
      expect(roadsOnly.city.buildings).toEqual([]);
      expect(roadsOnly.city.parks).toEqual([]);
    }

    // A failed fetch offers the pinned city and carries no geometry of its own.
    const failed = await loadLiveCity(MIDTOWN, { fetchTiles: async () => { throw new Error("network down"); } });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.fallback).toBe("pinned-midtown");
    expect(failed.reason).toContain("network down");
    expect(failed.reason).toContain("pinned Midtown");
    expect("city" in failed).toBe(false);

    const playable = await loadPlayableCity(MIDTOWN, {
      live: { fetchTiles: async () => { throw new Error("network down"); } },
      pinned: async () => pinnedCity,
    });
    expect(playable.live).toBe(false);
    expect(playable.city).toBe(pinnedCity);
    expect(playable.reason).toContain("network down");
    const liveOk = await loadPlayableCity(MIDTOWN, { live: { fetchTiles: async () => tileSet(features) }, pinned: async () => pinnedCity });
    expect(liveOk.live).toBe(true);
    expect(liveOk.reason).toBeNull();
    expect(liveOk.city).not.toBe(pinnedCity);
  });

  it("WRECK-T14: tile building heights come from render_height then a labelled default", () => {
    const base = (properties: TileFeature["properties"], northM: number): TileFeature => ({ layer: "building", geometry: "Polygon", parts: [boxAround(20, northM)], properties });
    const tall = base({ render_height: 42 }, 100);
    const unlabelled = base({}, -100);
    const elevated = base({ render_height: 30, render_min_height: 12 }, 200);
    const result = buildTileCity(tileSet([street(), tall, unlabelled, elevated]), center);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byHeight = result.city.buildings.map((b) => ({ h: b.height, s: b.heightSource })).sort((a, b) => a.h - b.h);
    expect(byHeight).toEqual([
      { h: DEFAULT_BUILDING_HEIGHT_M, s: "default" },
      { h: 42, s: "height" },
    ]);
    expect(result.stats.defaultHeights).toBe(1);
    // A part that starts above ground is not stacked from the ground up.
    expect(result.stats.elevatedPartsSkipped).toBe(1);
  });

  it("WRECK-T14: a tile city with no roads is refused with a reason", async () => {
    const buildingsOnly = midtownFeatures().filter((f) => f.layer === "building");
    const refused = buildTileCity(tileSet(buildingsOnly), center);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/no drivable roads/);

    const empty = buildTileCity(tileSet([]), center);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason.length).toBeGreaterThan(10);

    const footways: TileFeature = { layer: "transportation", geometry: "LineString", parts: [[[center.lon, center.lat], [center.lon + 0.001, center.lat]]], properties: { class: "path" } };
    const noCars = buildTileCity(tileSet([footways]), center);
    expect(noCars.ok).toBe(false);

    const outcome = await loadLiveCity(MIDTOWN, { fetchTiles: async () => tileSet(buildingsOnly) });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toMatch(/no drivable roads/);
      expect(outcome.fallback).toBe("pinned-midtown");
    }
  });

  it("WRECK-T14: a cached city reloads without fetching", async () => {
    const features = midtownFeatures();
    let fetches = 0;
    const deps = { fetchTiles: async () => { fetches += 1; return tileSet(features); }, cache: createMemoryStore() };
    const first = await loadLiveCity(MIDTOWN, deps);
    expect(first.ok && first.from).toBe("network");
    expect(fetches).toBe(1);

    const second = await loadLiveCity(MIDTOWN, deps);
    expect(second.ok && second.from).toBe("cache");
    expect(fetches).toBe(1);
    expect(second.ok && second.city).toEqual(first.ok && first.city);

    // A pick within the rounding distance shares the city; one far away does not.
    const near = await loadLiveCity({ lat: MIDTOWN.lat + 0.0001, lon: MIDTOWN.lon - 0.0001 }, deps);
    expect(near.ok && near.from).toBe("cache");
    expect(fetches).toBe(1);
    expect(cityCacheKey({ lat: 40.7001, lon: -73.9 })).not.toBe(cityCacheKey(MIDTOWN));

    // The IndexedDB store keeps a city across store instances over the same database.
    const factory = fakeIndexedDb();
    const idbDeps = { fetchTiles: async () => { fetches += 1; return tileSet(features); }, cache: createIndexedDbStore(factory) };
    const stored = await loadLiveCity(MIDTOWN, idbDeps);
    expect(stored.ok && stored.from).toBe("network");
    const before = fetches;
    const reopened = await loadLiveCity(MIDTOWN, { ...idbDeps, cache: createIndexedDbStore(factory) });
    expect(reopened.ok && reopened.from).toBe("cache");
    expect(fetches).toBe(before);

    // A broken cache never blocks play: the city is built from tiles and the problem is noted.
    const broken: CityStore = { get: async () => { throw new Error("storage full"); }, put: async () => { throw new Error("storage full"); } };
    const unstored = await loadLiveCity(MIDTOWN, { fetchTiles: async () => tileSet(features), cache: broken });
    expect(unstored.ok).toBe(true);
    expect(unstored.notes.join(" ")).toContain("storage full");
    await expect(createIndexedDbStore(undefined).get("x")).rejects.toThrow(/not available/);
  });

  it("covers a 700 m square with at most four z14 tiles and refuses places that need more", () => {
    const tiles = tilesCovering(MIDTOWN);
    expect(tiles.length).toBeGreaterThanOrEqual(1);
    expect(tiles.length).toBeLessThanOrEqual(4);
    expect(tiles.every((t) => t.z === 14)).toBe(true);
    expect(() => tilesCovering({ lat: 78, lon: 15 })).toThrow(/outside the area/);
    expect(() => tilesCovering({ lat: Number.NaN, lon: 0 })).toThrow();
  });

  it("hashes the tile features with a pure SHA-256", () => {
    for (const text of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "naïve ✓ tiles"]) {
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
    }
    const city: CityData | null = (() => { const r = buildTileCity(tileSet(midtownFeatures()), center); return r.ok ? r.city : null; })();
    expect(city?.source.sha256).toBe(sha256Hex(JSON.stringify(midtownFeatures())));
  });
});

/** The smallest IndexedDB that answers `open`, `transaction`, `get` and `put`, one database per factory. */
function fakeIndexedDb(): IDBFactory {
  const data = new Map<string, unknown>();
  let created = false;
  const later = (run: () => void): void => queueMicrotask(run);
  const db = {
    objectStoreNames: { contains: () => created },
    createObjectStore: () => { created = true; },
    transaction: () => {
      const tx: { oncomplete?: () => void; objectStore?: () => unknown } = {};
      tx.objectStore = () => ({
        get: (key: string) => {
          const request: { result?: unknown; onsuccess?: () => void } = {};
          later(() => { request.result = data.get(key); request.onsuccess?.(); });
          return request;
        },
        put: (value: unknown, key: string) => {
          data.set(key, structuredClone(value));
          const request: { result?: unknown; onsuccess?: () => void } = {};
          later(() => { request.result = key; request.onsuccess?.(); tx.oncomplete?.(); });
          return request;
        },
      });
      return tx;
    },
  };
  return {
    open: () => {
      const request: { result?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void } = { result: db };
      later(() => {
        if (!created) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
}
