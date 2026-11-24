/**
 * Procedural materials for the city: facades with window grids and storefront bands, asphalt with
 * lane markings, sidewalk slabs and grass. Everything is drawn into small canvases at start-up, so
 * the game ships no image files and every texture is original to this repository.
 */
import { BackSide, CanvasTexture, Color, Float32BufferAttribute, LinearMipmapLinearFilter, MeshBasicMaterial, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, SphereGeometry, type Texture } from "three";

export interface FacadePalette {
  wall: string;
  trim: string;
  glass: string;
  lit: string;
  storefront: string;
  awning: string;
  roof: string;
}

export const FACADE_PALETTES: readonly FacadePalette[] = [
  { wall: "#b9a58c", trim: "#d8cbb4", glass: "#2a3a48", lit: "#f1d38a", storefront: "#1d2a33", awning: "#8a2f2f", roof: "#59534d" },
  { wall: "#8f8a86", trim: "#b6b1ab", glass: "#27353f", lit: "#e9d9a6", storefront: "#202d36", awning: "#2f5d73", roof: "#4c4b4a" },
  { wall: "#a0554a", trim: "#c9a79a", glass: "#2b3640", lit: "#f3d792", storefront: "#1e2a31", awning: "#d8c27a", roof: "#524845" },
  { wall: "#6e7f8c", trim: "#a5b3bd", glass: "#1f2d38", lit: "#d9ecff", storefront: "#162129", awning: "#c4572f", roof: "#454c52" },
  { wall: "#c9bfae", trim: "#e5dcca", glass: "#33424d", lit: "#f6df9c", storefront: "#26343c", awning: "#3d6b4f", roof: "#5e5a54" },
  { wall: "#5d6168", trim: "#8c9199", glass: "#1a252e", lit: "#bfe1ff", storefront: "#12191f", awning: "#9b7bb1", roof: "#3f4347" },
];

/** Metres of wall one texture tile covers: two window bays wide, one storey tall. */
export const BAY_WIDTH_M = 3.2;
export const TILE_WIDTH_M = BAY_WIDTH_M * 2;
export const FLOOR_HEIGHT_M = 3.2;
/** Height of the storefront band at street level. */
export const GROUND_FLOOR_M = 4.5;

/** Stable variety from a building id, so the same building always gets the same look. */
export function facadeVariant(id: number, count: number = FACADE_PALETTES.length): number {
  let h = Math.imul(Math.abs(Math.trunc(id)) + 1, 0x9e3779b1) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  return (h >>> 8) % count;
}

function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("A 2D canvas is needed to draw the city materials.");
  return [canvas, ctx];
}

function finish(canvas: HTMLCanvasElement, repeat = true): Texture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  if (repeat) { texture.wrapS = RepeatWrapping; texture.wrapT = RepeatWrapping; }
  texture.anisotropy = 4;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number, amount: number, alpha: number): void {
  for (let i = 0; i < amount; i += 1) {
    ctx.fillStyle = rng() < 0.5 ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha})`;
    ctx.fillRect(rng() * w, rng() * h, 1 + rng() * 2, 1 + rng() * 2);
  }
}

/** Upper storeys: a wall with two window bays per tile. Tile is TILE_WIDTH_M by FLOOR_HEIGHT_M. */
export function makeUpperFacade(p: FacadePalette, seed: number): Texture {
  const [canvas, ctx] = makeCanvas(256, 128);
  const rng = noise(seed);
  ctx.fillStyle = p.wall;
  ctx.fillRect(0, 0, 256, 128);
  speckle(ctx, 256, 128, rng, 500, 0.05);
  ctx.fillStyle = p.trim;
  ctx.fillRect(0, 0, 256, 6);
  for (let bay = 0; bay < 2; bay += 1) {
    const x = bay * 128 + 28;
    ctx.fillStyle = p.trim;
    ctx.fillRect(x - 5, 22, 82, 86);
    const lit = rng() < 0.28;
    const glass = ctx.createLinearGradient(0, 28, 0, 104);
    glass.addColorStop(0, lit ? p.lit : "#4a6577");
    glass.addColorStop(1, lit ? "#c9a85e" : p.glass);
    ctx.fillStyle = glass;
    ctx.fillRect(x, 27, 72, 76);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(x + 35, 27, 3, 76);
    ctx.fillRect(x, 62, 72, 3);
  }
  return finish(canvas);
}

/** Street level: a glazed storefront with an awning. Tile is TILE_WIDTH_M by GROUND_FLOOR_M. */
export function makeGroundFacade(p: FacadePalette, seed: number): Texture {
  const [canvas, ctx] = makeCanvas(256, 180);
  const rng = noise(seed ^ 0x5bd1e995);
  ctx.fillStyle = p.storefront;
  ctx.fillRect(0, 0, 256, 180);
  speckle(ctx, 256, 180, rng, 300, 0.06);
  ctx.fillStyle = p.awning;
  ctx.fillRect(0, 22, 256, 26);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  for (let x = 0; x < 256; x += 16) ctx.fillRect(x, 22, 8, 26);
  const glass = ctx.createLinearGradient(0, 56, 0, 170);
  glass.addColorStop(0, "#5c7f94");
  glass.addColorStop(1, "#22333e");
  ctx.fillStyle = glass;
  ctx.fillRect(10, 56, 108, 114);
  ctx.fillRect(138, 56, 108, 114);
  ctx.fillStyle = p.trim;
  ctx.fillRect(0, 0, 256, 8);
  ctx.fillRect(124, 56, 8, 124);
  ctx.fillStyle = "rgba(255,230,160,0.35)";
  ctx.fillRect(18, 96, 92, 44);
  return finish(canvas);
}

/** Asphalt across the road (u: 0..1) with markings along it; v repeats every ROAD_TILE_M. */
export const ROAD_TILE_M = 12;
export function makeRoadTexture(lanes: number, oneway: boolean): Texture {
  const [canvas, ctx] = makeCanvas(256, 256);
  const rng = noise(lanes * 31 + (oneway ? 7 : 0));
  ctx.fillStyle = "#34373a";
  ctx.fillRect(0, 0, 256, 256);
  speckle(ctx, 256, 256, rng, 2400, 0.07);
  ctx.fillStyle = "#d9d9cf";
  ctx.fillRect(7, 0, 4, 256);
  ctx.fillRect(245, 0, 4, 256);
  const dividers = Math.max(1, lanes) - 1;
  for (let i = 1; i <= dividers; i += 1) {
    const x = Math.round((256 * i) / (dividers + 1));
    const centre = !oneway && i === Math.ceil(dividers / 2) && dividers % 2 === 1;
    if (centre) {
      ctx.fillStyle = "#e0b43a";
      ctx.fillRect(x - 5, 0, 3, 256);
      ctx.fillRect(x + 2, 0, 3, 256);
    } else {
      ctx.fillStyle = "#d9d9cf";
      for (let y = 0; y < 256; y += 85) ctx.fillRect(x - 2, y, 4, 48);
    }
  }
  return finish(canvas);
}

export function makeSidewalkTexture(): Texture {
  const [canvas, ctx] = makeCanvas(128, 128);
  const rng = noise(99);
  ctx.fillStyle = "#9a9a94";
  ctx.fillRect(0, 0, 128, 128);
  speckle(ctx, 128, 128, rng, 700, 0.07);
  ctx.strokeStyle = "rgba(40,40,40,0.5)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 126, 126);
  return finish(canvas);
}

export function makeGrassTexture(): Texture {
  const [canvas, ctx] = makeCanvas(128, 128);
  const rng = noise(7);
  ctx.fillStyle = "#4f7a3e";
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 900; i += 1) {
    ctx.fillStyle = `hsl(${88 + rng() * 30},${35 + rng() * 25}%,${28 + rng() * 22}%)`;
    ctx.fillRect(rng() * 128, rng() * 128, 2, 3);
  }
  return finish(canvas);
}

export interface CityMaterials {
  upper: MeshStandardMaterial[];
  ground: MeshStandardMaterial[];
  roof: MeshStandardMaterial[];
  /** Road material for a lane count and direction, drawn on first use. */
  road(lanes: number, oneway: boolean): MeshStandardMaterial;
  junction: MeshStandardMaterial;
  sidewalk: MeshStandardMaterial;
  grass: MeshStandardMaterial;
  base: MeshStandardMaterial;
  sky: MeshBasicMaterial;
  dispose(): void;
}

/** Fog and sky colours shared by the scene so the horizon blends into the haze. */
export const HAZE = "#b9c7d4";
export const SKY_TOP = "#5f8fc4";

export function roadKey(lanes: number, oneway: boolean): string {
  return `${Math.max(1, lanes)}-${oneway ? 1 : 0}`;
}

export function createCityMaterials(): CityMaterials {
  const textures: Texture[] = [];
  const keep = <T extends Texture>(t: T): T => { textures.push(t); return t; };
  const upper = FACADE_PALETTES.map((p, i) => new MeshStandardMaterial({ map: keep(makeUpperFacade(p, i + 1)), roughness: 0.85, metalness: 0.02 }));
  const ground = FACADE_PALETTES.map((p, i) => new MeshStandardMaterial({ map: keep(makeGroundFacade(p, i + 1)), roughness: 0.7, metalness: 0.05 }));
  const roof = FACADE_PALETTES.map((p) => new MeshStandardMaterial({ color: new Color(p.roof), roughness: 0.95 }));
  const roads = new Map<string, MeshStandardMaterial>();
  const road = (lanes: number, oneway: boolean): MeshStandardMaterial => {
    const key = roadKey(lanes, oneway);
    let material = roads.get(key);
    if (!material) {
      material = new MeshStandardMaterial({ map: keep(makeRoadTexture(Math.max(1, lanes), oneway)), roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      roads.set(key, material);
    }
    return material;
  };
  const junction = new MeshStandardMaterial({ color: "#34373a", roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const sidewalk = new MeshStandardMaterial({ map: keep(makeSidewalkTexture()), roughness: 0.95 });
  const grass = new MeshStandardMaterial({ map: keep(makeGrassTexture()), roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const base = new MeshStandardMaterial({ color: "#6d706b", roughness: 1 });
  const sky = new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false, depthWrite: false });
  const fixed = [...upper, ...ground, ...roof, junction, sidewalk, grass, base, sky];
  return { upper, ground, roof, road, junction, sidewalk, grass, base, sky, dispose() { for (const t of textures) t.dispose(); for (const m of [...fixed, ...roads.values()]) m.dispose(); } };
}

/** A gradient dome: deep blue overhead, haze at the horizon, matching the fog. */
export function createSkyGeometry(): SphereGeometry {
  const geometry = new SphereGeometry(700, 24, 12);
  const top = new Color(SKY_TOP);
  const haze = new Color(HAZE);
  const position = geometry.getAttribute("position");
  const colors: number[] = [];
  for (let i = 0; i < position.count; i += 1) {
    const t = Math.max(0, Math.min(1, position.getY(i) / 500));
    const c = haze.clone().lerp(top, Math.pow(t, 0.7));
    colors.push(c.r, c.g, c.b);
  }
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return geometry;
}
