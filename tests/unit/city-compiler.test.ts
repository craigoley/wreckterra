import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildingHeight,
  CityCompileError,
  compileCity,
  DEFAULT_BUILDING_HEIGHT_M,
  isSelfIntersecting,
  LEVEL_HEIGHT_M,
  parseHeightMeters,
  pointInRing,
  serializeCity,
  type CityData,
  type OsmSnapshot,
  type SnapshotReceipt,
  type Vec2,
} from "../../src/maps/city-compiler";
import { CAR_HIT_RADIUS, circleVsFootprint, createCityWorld, hitCircles, loadCity, parseCity } from "../../src/maps/midtown";
import { angleDelta, chaseShot } from "../../src/game/ChaseCamera";
import { buildCityGeometry, nextQuality, QUALITY_LEVELS, readControls } from "../../src/game/CityScene";
import { facadeVariant } from "../../src/game/cityMaterials";
import { IDLE } from "../../src/game/TouchControls";
import { CONTRACT_VERSION, TICK_SECONDS } from "../../src/sim/contracts";
import { createRng } from "../../src/sim/world";

const dir = resolve(__dirname, "../../public/maps/midtown");
const sourceText = readFileSync(resolve(dir, "source.osm.json"), "utf8");
const cityText = readFileSync(resolve(dir, "city.json"), "utf8");
const snapshot = JSON.parse(sourceText) as OsmSnapshot;

const receipt: SnapshotReceipt = {
  kind: "openstreetmap", url: "https://example.invalid/overpass", retrievedAt: "2026-01-01", sha256: "0".repeat(64),
  bbox: { south: 40.76, west: -73.98, north: 40.77, east: -73.97 }, origin: { lat: 40.7645, lon: -73.977 },
};

/** A tiny hand-built snapshot: one road and the given ways, around the receipt origin. */
function mini(extra: unknown[], nodes: Array<[number, number, number]> = []): OsmSnapshot {
  const base: unknown[] = [
    { type: "node", id: 1, lat: 40.7645, lon: -73.9775 },
    { type: "node", id: 2, lat: 40.7645, lon: -73.9765 },
    { type: "way", id: 10, nodes: [1, 2], tags: { highway: "residential" } },
  ];
  return { wreckterra: receipt, elements: [...nodes.map(([id, lat, lon]) => ({ type: "node", id, lat, lon })), ...base, ...extra] };
}

const squareNodes: Array<[number, number, number]> = [
  [21, 40.7650, -73.9775], [22, 40.7650, -73.9772], [23, 40.7653, -73.9772], [24, 40.7653, -73.9775],
];
const squareWay = (tags: Record<string, string>) => ({ type: "way", id: 30, nodes: [21, 22, 23, 24, 21], tags: { building: "yes", ...tags } });

describe("WRECK-T11: real-city compiler and driving", () => {
  it("WRECK-T11: the city compiler is deterministic and yields buildings, roads and road spawns", () => {
    // The pinned snapshot is intact: its recorded hash matches its elements.
    expect(createHash("sha256").update(JSON.stringify(snapshot.elements)).digest("hex")).toBe(snapshot.wreckterra.sha256);

    const first = compileCity(snapshot);
    const second = compileCity(JSON.parse(sourceText) as OsmSnapshot);
    expect(serializeCity(first)).toBe(serializeCity(second));
    // Same snapshot, same bytes as the committed city file.
    expect(serializeCity(first)).toBe(cityText);

    expect(first.buildings.length).toBeGreaterThan(20);
    expect(first.roads.length).toBeGreaterThan(3);
    expect(first.sidewalks.length).toBeGreaterThan(0);
    expect(first.parks.length).toBeGreaterThan(0);
    expect(first.trees.length).toBeGreaterThan(0);
    expect(first.graph.nodes.length).toBeGreaterThan(4);
    expect(first.graph.edges.length).toBeGreaterThan(4);
    for (const edge of first.graph.edges) {
      expect(first.graph.nodes[edge.from]).toBeDefined();
      expect(first.graph.nodes[edge.to]).toBeDefined();
      expect(edge.length).toBeGreaterThan(0);
    }
    for (const b of first.buildings) {
      expect(b.footprint.length).toBeGreaterThanOrEqual(3);
      expect(b.height).toBeGreaterThan(0);
      expect(["height", "levels", "default"]).toContain(b.heightSource);
    }
    // Spawns sit on a road, clear of every footprint, and face along it.
    expect(first.spawns.length).toBeGreaterThanOrEqual(4);
    for (const s of first.spawns) {
      expect(Number.isFinite(s.heading)).toBe(true);
      expect(first.buildings.some((b) => pointInRing([s.x, s.z], b.footprint))).toBe(false);
      const onRoad = first.roads.some((r) => r.points.slice(1).some((p, i) => {
        const a = r.points[i]!;
        const len2 = (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
        const t = Math.max(0, Math.min(1, ((s.x - a[0]) * (p[0] - a[0]) + (s.z - a[1]) * (p[1] - a[1])) / len2));
        return Math.hypot(s.x - (a[0] + t * (p[0] - a[0])), s.z - (a[1] + t * (p[1] - a[1]))) < r.width / 2;
      }));
      expect(onRoad).toBe(true);
    }
    // The compiled file is honest about where it came from.
    expect(first.source.sha256).toBe(snapshot.wreckterra.sha256);
    expect(first.source.attribution.length).toBeGreaterThan(0);
  });

  it("WRECK-T11: building heights come from height then levels then a labelled default", () => {
    expect(buildingHeight({ height: "45", "building:levels": "3" })).toEqual({ height: 45, source: "height" });
    expect(buildingHeight({ height: "150 ft" })).toEqual({ height: 45.72, source: "height" });
    expect(buildingHeight({ height: "12.5 m" })).toEqual({ height: 12.5, source: "height" });
    // No usable height: levels times the storey height.
    expect(buildingHeight({ "building:levels": "10" })).toEqual({ height: 10 * LEVEL_HEIGHT_M, source: "levels" });
    expect(buildingHeight({ height: "tall", "building:levels": "5" })).toEqual({ height: 5 * LEVEL_HEIGHT_M, source: "levels" });
    // Neither: the labelled default, never a silent zero.
    expect(buildingHeight({})).toEqual({ height: DEFAULT_BUILDING_HEIGHT_M, source: "default" });
    expect(buildingHeight(undefined)).toEqual({ height: DEFAULT_BUILDING_HEIGHT_M, source: "default" });
    for (const junk of ["NaN", "Infinity", "-5", "0", "1e9", "", "abc"]) {
      expect(buildingHeight({ height: junk, "building:levels": junk }).source).toBe("default");
    }
    expect(parseHeightMeters("60'")).toBeCloseTo(18.288, 3);

    // The compiler applies the same order to real ways.
    const city = compileCity(mini([squareWay({ "building:levels": "6" })], squareNodes));
    expect(city.buildings).toHaveLength(1);
    expect(city.buildings[0]).toMatchObject({ height: 19.2, heightSource: "levels" });
    expect(compileCity(mini([squareWay({})], squareNodes)).buildings[0]).toMatchObject({ height: DEFAULT_BUILDING_HEIGHT_M, heightSource: "default" });
    // The pinned city uses every source, and every building says which one it used.
    const sources = new Set(parseCity(JSON.parse(cityText)).buildings.map((b) => b.heightSource));
    expect(sources.has("levels")).toBe(true);
  });

  it("WRECK-T11: bad geometry is rejected", () => {
    // Non-finite coordinates.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const poisoned: OsmSnapshot = mini([], [[99, bad, -73.97]]);
      expect(() => compileCity(poisoned)).toThrow(CityCompileError);
    }
    expect(() => compileCity(mini([], [[99, 95, -73.97]]))).toThrow(/out of range/);
    expect(() => compileCity({ wreckterra: { ...receipt, origin: { lat: Number.NaN, lon: 0 } }, elements: [] })).toThrow(CityCompileError);

    // A bow-tie footprint crosses itself.
    const bowtie: Array<[number, number, number]> = [
      [41, 40.7650, -73.9775], [42, 40.7653, -73.9772], [43, 40.7650, -73.9772], [44, 40.7653, -73.9775],
    ];
    const bowtieWay = { type: "way", id: 40, nodes: [41, 42, 43, 44, 41], tags: { building: "yes" } };
    expect(() => compileCity(mini([bowtieWay], bowtie))).toThrow(/self-intersecting/);
    // A footprint with a missing node is rejected too.
    expect(() => compileCity(mini([{ type: "way", id: 41, nodes: [21, 22, 23, 777, 21], tags: { building: "yes" } }], squareNodes))).toThrow(/missing node/);
    // Skip mode drops the way but records why, and keeps the good ones.
    const skipped = compileCity(mini([bowtieWay, squareWay({})], [...bowtie, ...squareNodes]), { invalid: "skip" });
    expect(skipped.rejected).toEqual([{ id: 40, reason: "self-intersecting footprint" }]);
    expect(skipped.buildings.map((b) => b.id)).toEqual([30]);
    // An empty snapshot is not a city.
    expect(() => compileCity({ wreckterra: receipt, elements: [] })).toThrow(/no buildings/);

    const square: Vec2[] = [[0, 0], [4, 0], [4, 4], [0, 4]];
    expect(isSelfIntersecting(square)).toBe(false);
    expect(isSelfIntersecting([[0, 0], [4, 4], [4, 0], [0, 4]])).toBe(true);
    expect(isSelfIntersecting([[0, 0], [4, 0], [4, 4], [2, 0], [0, 4]])).toBe(true);
    // The loader refuses a damaged city file as well.
    expect(() => parseCity({ version: 1 })).toThrow(/not usable/);
    const broken = JSON.parse(cityText) as CityData;
    broken.buildings[0]!.footprint[0] = [Number.NaN, 0];
    expect(() => parseCity(broken)).toThrow(/bad footprint/);
  });

  it("WRECK-T11: the car cannot drive through a building", () => {
    const city = parseCity(JSON.parse(cityText));
    const inside = (cx: number, cz: number) => city.buildings.some((b) => pointInRing([cx, cz], b.footprint));
    const clear = (x: number, z: number, heading: number) => hitCircles(x, z, heading).every(([cx, cz]) =>
      city.buildings.every((b) => circleVsFootprint(cx, cz, CAR_HIT_RADIUS, b.footprint) === null));

    let drivenInto = 0;
    let impacts = 0;
    city.buildings.flatMap((b, index) => [0, 1, 2].map((k) => [b, index * 3 + k] as const)).forEach(([b, index]) => {
      // Aim at the middle of the building from a spot 22 m away at a varying angle.
      const cx = b.footprint.reduce((s, p) => s + p[0], 0) / b.footprint.length;
      const cz = b.footprint.reduce((s, p) => s + p[1], 0) / b.footprint.length;
      const angle = index * 2.399;
      const sx = cx + Math.cos(angle) * 22;
      const sz = cz + Math.sin(angle) * 22;
      const heading = Math.atan2(cx - sx, cz - sz);
      if (!clear(sx, sz, heading)) return;
      const world = createCityWorld({ ...city, spawns: [{ x: sx, z: sz, heading }] }, { seed: 1 });
      world.drainEvents();
      expect(world.submitInput({ v: CONTRACT_VERSION, tick: 0, playerId: "player-1", steer: 0, throttle: 1, brake: false })).toEqual({ accepted: true });
      for (let t = 0; t < 420; t += 1) {
        world.advance(TICK_SECONDS);
        const car = world.snapshot().vehicles[0]!;
        for (const [hx, hz] of hitCircles(car.x, car.z, car.heading)) expect(inside(hx, hz)).toBe(false);
        expect(inside(car.x, car.z)).toBe(false);
      }
      drivenInto += 1;
      if (world.drainEvents().some((e) => e.kind === "impact")) impacts += 1;
    });
    // The test really drove at buildings (including L-shaped ones) and hit them.
    expect(drivenInto).toBeGreaterThan(30);
    expect(impacts).toBeGreaterThan(10);

    // Wander for a minute with seeded steering: never inside a footprint, never non-finite.
    const rng = createRng(11);
    const world = createCityWorld(city, { seed: 11, vehicle: "voltage" });
    let steer = 0;
    let throttle = 1;
    for (let t = 0; t < 3600; t += 1) {
      if (t % 45 === 0) { steer = rng() * 2 - 1; throttle = rng() < 0.85 ? 1 : -1; }
      world.submitInput({ v: CONTRACT_VERSION, tick: t, playerId: "player-1", steer, throttle, brake: rng() < 0.05 });
      world.advance(TICK_SECONDS);
      const car = world.snapshot().vehicles[0]!;
      expect(Number.isFinite(car.x) && Number.isFinite(car.z) && Number.isFinite(car.speed)).toBe(true);
      expect(inside(car.x, car.z)).toBe(false);
    }
    expect(world.snapshot().tick).toBe(3600);

    // The same inputs reproduce the same drive exactly; bad inputs are refused.
    const run = () => {
      const w = createCityWorld(city, { seed: 5 });
      for (let t = 0; t < 300; t += 1) {
        w.submitInput({ v: CONTRACT_VERSION, tick: t, playerId: "player-1", steer: t % 90 < 45 ? 0.6 : -0.3, throttle: 1, brake: false });
        w.advance(TICK_SECONDS);
      }
      return w.snapshot();
    };
    expect(run()).toEqual(run());
    expect(world.submitInput({ v: CONTRACT_VERSION, tick: 0, playerId: "player-1", steer: Number.NaN, throttle: 0, brake: false })).toEqual({ accepted: false, reason: "out-of-range" });
    expect(world.submitInput({ v: 2, tick: 0, playerId: "player-1", steer: 0, throttle: 0, brake: false })).toEqual({ accepted: false, reason: "bad-version" });
    expect(world.advance(30)).toBe(5);
  });

  it("WRECK-T11: the app loads the compiled city through loadCity and rejects a bad response", async () => {
    const fetched: string[] = [];
    const ok = async (url: string | URL | Request) => { fetched.push(String(url)); return new Response(cityText, { status: 200 }); };
    const city = await loadCity("/maps/midtown/city.json", ok as typeof fetch);
    expect(fetched).toEqual(["/maps/midtown/city.json"]);
    expect(city.buildings.length).toBeGreaterThan(20);
    await expect(loadCity("/x", (async () => new Response("no", { status: 404 })) as typeof fetch)).rejects.toThrow(/HTTP 404/);
    await expect(loadCity("/x", (async () => new Response("{}", { status: 200 })) as typeof fetch)).rejects.toThrow(/not usable/);
  });

  it("WRECK-T11: the 3D city merges into few draw calls with outward walls and upward roofs", () => {
    const city = parseCity(JSON.parse(cityText));
    const geometry = buildCityGeometry(city);
    const meshes = [...geometry.upper, ...geometry.ground, ...geometry.roof].filter(Boolean).length + geometry.roads.length
      + [geometry.junctions, geometry.sidewalks, geometry.parks].filter(Boolean).length;
    // 64 buildings and every road, sidewalk and park collapse into a couple of dozen meshes at most.
    expect(meshes).toBeLessThan(30);
    expect(meshes).toBeGreaterThan(5);
    // Every triangle of every building wall winds so that it faces along its stored normal.
    for (const g of [...geometry.upper, ...geometry.ground, ...geometry.roof]) {
      if (!g) continue;
      const pos = g.getAttribute("position");
      const nor = g.getAttribute("normal");
      const index = g.getIndex()!;
      for (let i = 0; i < index.count; i += 3) {
        const [a, b, c] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
        const u = [pos.getX(b) - pos.getX(a), pos.getY(b) - pos.getY(a), pos.getZ(b) - pos.getZ(a)];
        const v = [pos.getX(c) - pos.getX(a), pos.getY(c) - pos.getY(a), pos.getZ(c) - pos.getZ(a)];
        const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
        const facing = cross[0]! * nor.getX(a) + cross[1]! * nor.getY(a) + cross[2]! * nor.getZ(a);
        expect(facing).toBeGreaterThanOrEqual(0);
      }
    }
    // The same building always gets the same facade; the palette is actually used.
    expect(facadeVariant(1234)).toBe(facadeVariant(1234));
    expect(new Set(city.buildings.map((b) => facadeVariant(b.id))).size).toBeGreaterThan(3);
    geometry.dispose();
  });

  it("WRECK-T11: the camera trails the car, quality adapts to frame time and controls map to input", () => {
    const behind = chaseShot({ x: 10, z: 20, heading: 0, speed: 0 }, 0, 30);
    expect(behind.position[2]).toBeLessThan(20);
    expect(behind.position[1]).toBeGreaterThan(2);
    expect(behind.look[2]).toBeGreaterThan(20);
    expect(chaseShot({ x: 0, z: 0, heading: 0, speed: 30 }, 0, 30).fov).toBeGreaterThan(behind.fov);
    expect(angleDelta(3.1, -3.1)).toBeCloseTo(2 * Math.PI - 6.2, 5);

    // Slow frames step quality down at once; sustained fast frames step it up one level at a time.
    expect(nextQuality(2, 1 / 20, 0)).toEqual({ level: 1, goodWindows: 0 });
    expect(nextQuality(0, 1 / 20, 0).level).toBe(0);
    let state = { level: 1, goodWindows: 0 };
    for (let i = 0; i < 3; i += 1) state = nextQuality(state.level, 1 / 60, state.goodWindows);
    expect(state.level).toBe(2);
    expect(nextQuality(QUALITY_LEVELS.length - 1, 1 / 60, 5).level).toBe(QUALITY_LEVELS.length - 1);
    expect(nextQuality(2, 1 / 45, 2)).toEqual({ level: 2, goodWindows: 0 });

    expect(readControls({ ...IDLE, gas: true, left: true }, null)).toEqual({ steer: -1, throttle: 1, brake: false });
    const pad = { axes: [0.6], buttons: [{}, {}, {}, { pressed: true }, {}, {}, {}, { value: 0.5 }] };
    expect(readControls(IDLE, pad)).toEqual({ steer: 0.6, throttle: 0.5, brake: true });
    expect(readControls({ ...IDLE, right: true }, pad).steer).toBe(1);
  });
});
