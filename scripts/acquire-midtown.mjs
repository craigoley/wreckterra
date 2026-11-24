#!/usr/bin/env node
// Developer-time acquisition of the Midtown snapshot. Production never calls Overpass.
//
//   node scripts/acquire-midtown.mjs                 download from Overpass, pin it, compile city.json
//   node scripts/acquire-midtown.mjs --compile-only  recompile city.json from the pinned source
//   node scripts/acquire-midtown.mjs --skip-invalid  drop (and record) ways with bad geometry
//   node scripts/acquire-midtown.mjs --stand-in      write the synthetic stand-in snapshot (offline)
//
// --stand-in exists for machines that cannot reach Overpass. It writes a clearly labelled synthetic
// layout in the same JSON shape (kind "synthetic-stand-in", negative ids, no URL), never real OSM data.
// Run the plain command on a networked machine to replace it with the real extract.
//
// The pinned file carries its URL, retrieval date and a SHA-256 of its `elements` array, so a
// reviewer can see exactly what the city was built from.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileCity, serializeCity } from "../src/maps/city-compiler.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(root, "public/maps/midtown");
const sourcePath = resolve(dir, "source.osm.json");
const cityPath = resolve(dir, "city.json");

// Central Park South to West 56th Street, Sixth Avenue to Fifth Avenue, with the park edge.
const BBOX = { south: 40.7605, west: -73.9795, north: 40.7672, east: -73.9722 };
const ORIGIN = { lat: 40.76435, lon: -73.973 };
const URL = "https://overpass-api.de/api/interpreter";
const QUERY = `[out:json][timeout:90];
(
  way["building"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  way["highway"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  way["leisure"="park"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  node["natural"="tree"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
);
out body;
>;
out skel qt;`;

const sha256 = (elements) => createHash("sha256").update(JSON.stringify(elements)).digest("hex");

/** One element per line keeps the pinned file reviewable and its diffs small. */
function writeSource(receipt, elements) {
  const lines = elements.map((e) => `    ${JSON.stringify(e)}`).join(",\n");
  writeFileSync(sourcePath, `{\n  "wreckterra": ${JSON.stringify(receipt)},\n  "elements": [\n${lines}\n  ]\n}\n`);
}

async function acquire() {
  const response = await fetch(URL, { method: "POST", body: new URLSearchParams({ data: QUERY }) });
  if (!response.ok) throw new Error(`Overpass answered ${response.status} ${response.statusText}`);
  const body = await response.json();
  const elements = (body.elements ?? [])
    .filter((e) => e.type === "node" || e.type === "way")
    .sort((a, b) => (a.type === b.type ? a.id - b.id : a.type === "node" ? -1 : 1));
  if (!elements.some((e) => e.type === "way")) throw new Error("Overpass returned no ways; refusing to pin an empty snapshot");
  const receipt = {
    kind: "openstreetmap",
    url: URL,
    query: QUERY,
    retrievedAt: new Date().toISOString().slice(0, 10),
    sha256: sha256(elements),
    bbox: BBOX,
    origin: ORIGIN,
    note: `Overpass osm3s timestamp: ${body.osm3s?.timestamp_osm_base ?? "unknown"}`,
  };
  mkdirSync(dir, { recursive: true });
  writeSource(receipt, elements);
  console.log(`pinned ${elements.length} elements, sha256 ${receipt.sha256}`);
}

/* ---------------------------------------------------------------- synthetic stand-in */

function standInElements() {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const angle = 29 * rad; // the Manhattan grid is rotated about 29 degrees from true north
  const toLatLon = (s, a) => {
    const east = s * Math.cos(angle) + a * Math.sin(angle);
    const north = -s * Math.sin(angle) + a * Math.cos(angle);
    return { lat: +(ORIGIN.lat + north / R / rad).toFixed(7), lon: +(ORIGIN.lon + east / (R * Math.cos(ORIGIN.lat * rad)) / rad).toFixed(7) };
  };
  let next = -1;
  const elements = [];
  const nodeCache = new Map();
  const node = (s, a, tags) => {
    const key = `${s}/${a}`;
    if (!tags && nodeCache.has(key)) return nodeCache.get(key);
    const id = next--;
    elements.push({ type: "node", id, ...toLatLon(s, a), ...(tags ? { tags } : {}) });
    if (!tags) nodeCache.set(key, id);
    return id;
  };
  const ways = [];
  const way = (ids, tags) => ways.push({ type: "way", id: next--, nodes: ids, tags });

  // Seeded generator so the stand-in is identical on every run.
  let state = 20261124;
  const rng = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const FIFTH = 0;
  const SIXTH = -279;
  const streets = [
    { name: "Central Park South", a: 0, highway: "secondary", oneway: null, lanes: null },
    { name: "West 58th Street", a: -80.5, highway: "residential", oneway: "yes", lanes: null },
    { name: "West 57th Street", a: -161, highway: "secondary", oneway: null, lanes: null },
    { name: "West 56th Street", a: -241.5, highway: "residential", oneway: "yes", lanes: null },
  ];
  const WEST = -340;
  const EAST = 40;
  // Roads. Intersection nodes are shared so the street graph connects.
  const fifthStops = [130, ...streets.map((x) => x.a), -250];
  way(fifthStops.map((a) => node(FIFTH, a)), { highway: "primary", name: "Fifth Avenue", oneway: "yes", lanes: "4" });
  const sixthStops = [-250, ...streets.map((x) => x.a).reverse()];
  way(sixthStops.map((a) => node(SIXTH, a)), { highway: "primary", name: "Avenue of the Americas", oneway: "yes", lanes: "3" });
  for (const st of streets) {
    way([WEST, SIXTH, FIFTH, EAST].map((s) => node(s, st.a)), {
      highway: st.highway, name: st.name, ...(st.oneway ? { oneway: st.oneway } : {}), ...(st.lanes ? { lanes: st.lanes } : {}),
    });
  }
  // A park footpath (not drivable) to show non-road highways are ignored.
  way([node(-300, 30), node(-200, 60), node(-100, 40)], { highway: "footway" });

  // Park along the south edge of the real park.
  const parkRing = [[WEST, 10], [-10.6, 10], [-10.6, 130], [WEST, 130]].map(([s, a]) => node(s, a));
  way([...parkRing, parkRing[0]], { leisure: "park", name: "Central Park (stand-in)" });

  // Buildings fill each block with lots on its two street faces; every fourth lot is L-shaped.
  const halfWidth = { "Central Park South": 6, "West 58th Street": 4.25, "West 57th Street": 6, "West 56th Street": 4.25 };
  const curb = 3.8;
  const s0 = SIXTH + 5.1 + curb;
  const s1 = FIFTH - 6.8 - curb;
  const kinds = ["apartments", "commercial", "hotel", "office", "retail"];
  const heightTags = ["42", "58.5", "75 m", "96", "120", "148 m", "185", "250 ft", "300 ft", "410 ft"];
  let lot = 0;
  const addBuilding = (sa, sb, aa, ab) => {
    lot += 1;
    const tags = { building: kinds[Math.floor(rng() * kinds.length)] };
    const pick = rng();
    if (pick < 0.35) tags.height = heightTags[Math.floor(rng() * heightTags.length)];
    else if (pick < 0.8) tags["building:levels"] = String(5 + Math.floor(rng() * 44));
    let ring;
    if (lot % 4 === 0) {
      const ns = sa + (sb - sa) * 0.45;
      const na = aa + (ab - aa) * 0.5;
      ring = [[sa, aa], [sb, aa], [sb, na], [ns, na], [ns, ab], [sa, ab]];
    } else ring = [[sa, aa], [sb, aa], [sb, ab], [sa, ab]];
    const ids = ring.map(([s, a]) => node(s, a));
    way([...ids, ids[0]], tags);
  };
  for (let i = 0; i + 1 < streets.length; i += 1) {
    const top = streets[i];
    const bottom = streets[i + 1];
    const aTop = top.a - halfWidth[top.name] - curb;
    const aBottom = bottom.a + halfWidth[bottom.name] + curb;
    const depthNorth = 25 + rng() * 5;
    const depthSouth = 25 + rng() * 5;
    for (const [aa, ab] of [[aTop, aTop - depthNorth], [aBottom + depthSouth, aBottom]]) {
      let s = s0;
      while (s < s1 - 12) {
        let width = 16 + rng() * 18;
        if (s + width > s1 - 12) width = s1 - s;
        addBuilding(+s.toFixed(2), +(s + width).toFixed(2), +aa.toFixed(2), +ab.toFixed(2));
        s += width + (rng() < 0.25 ? 2 : 0);
      }
    }
  }
  // A handful of street trees along the south side of Central Park South.
  for (let s = -250; s <= -20; s += 46) node(s, -8.2, { natural: "tree" });

  const all = [...elements, ...ways];
  const lats = elements.map((e) => e.lat);
  const lons = elements.map((e) => e.lon);
  return { elements: all, bbox: { south: Math.min(...lats), west: Math.min(...lons), north: Math.max(...lats), east: Math.max(...lons) } };
}

function standIn() {
  const { elements, bbox } = standInElements();
  const receipt = {
    kind: "synthetic-stand-in",
    url: null,
    retrievedAt: "2026-11-24",
    sha256: sha256(elements),
    bbox,
    origin: ORIGIN,
    note: "SYNTHETIC. Not OpenStreetMap data: a rotated street grid with generated lots, written because Overpass was unreachable from the build sandbox. Replace by running `node scripts/acquire-midtown.mjs` on a networked machine.",
  };
  mkdirSync(dir, { recursive: true });
  writeSource(receipt, elements);
  console.log(`wrote synthetic stand-in: ${elements.length} elements, sha256 ${receipt.sha256}`);
}

function compile(options) {
  const snapshot = JSON.parse(readFileSync(sourcePath, "utf8"));
  const actual = sha256(snapshot.elements);
  if (actual !== snapshot.wreckterra.sha256) throw new Error(`source.osm.json does not match its pinned SHA-256 (${actual})`);
  const city = compileCity(snapshot, options);
  writeFileSync(cityPath, serializeCity(city));
  console.log(`compiled ${city.buildings.length} buildings, ${city.roads.length} roads, ${city.spawns.length} spawns; rejected ${city.rejected.length}`);
}

const args = new Set(process.argv.slice(2));
if (args.has("--stand-in")) standIn();
else if (!args.has("--compile-only")) await acquire();
compile({ invalid: args.has("--skip-invalid") ? "skip" : "throw" });
