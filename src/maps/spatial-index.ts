/**
 * A uniform grid over axis-aligned boxes. Each item is registered in every cell its box touches, so a
 * query reads only the cells it overlaps instead of every item in the city. Pure geometry: no clock,
 * no randomness, no allocation beyond the result of a box query.
 */
export interface IndexedBox { minX: number; maxX: number; minZ: number; maxZ: number }

export interface SpatialIndex {
  /** How many items the index holds. */
  readonly size: number;
  /** Ids of every item whose box overlaps the query box, once each, in ascending order. */
  query(minX: number, minZ: number, maxX: number, maxZ: number): number[];
  /**
   * Visit each item whose cells a ray passes through, nearest cell first, once per item. The visitor
   * returns the distance beyond which nothing matters any more (the nearest hit so far); the walk
   * stops once the next cell starts past it. Do not query the same index from inside the visitor.
   */
  along(ox: number, oz: number, dx: number, dz: number, limit: number, visit: (id: number) => number): void;
}

/** Cell edge in metres: about a city block, so a car-sized query touches one to four cells. */
export const DEFAULT_CELL_METRES = 40;
/** Boxes are grown by this much so a ray that grazes a cell edge cannot slip between two cells. */
const EDGE_SLACK = 1e-6;

export function createSpatialIndex(boxes: readonly IndexedBox[], cellMetres: number = DEFAULT_CELL_METRES): SpatialIndex {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.minX - EDGE_SLACK); z0 = Math.min(z0, b.minZ - EDGE_SLACK);
    x1 = Math.max(x1, b.maxX + EDGE_SLACK); z1 = Math.max(z1, b.maxZ + EDGE_SLACK);
  }
  if (boxes.length === 0) { x0 = 0; z0 = 0; x1 = 0; z1 = 0; }
  const cell = Math.max(cellMetres, 1e-3);
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell));
  const nz = Math.max(1, Math.ceil((z1 - z0) / cell));
  const cells: number[][] = Array.from({ length: nx * nz }, () => []);
  const colOf = (x: number): number => Math.max(0, Math.min(nx - 1, Math.floor((x - x0) / cell)));
  const rowOf = (z: number): number => Math.max(0, Math.min(nz - 1, Math.floor((z - z0) / cell)));

  boxes.forEach((b, id) => {
    const [c0, c1, r0, r1] = [colOf(b.minX - EDGE_SLACK), colOf(b.maxX + EDGE_SLACK), rowOf(b.minZ - EDGE_SLACK), rowOf(b.maxZ + EDGE_SLACK)];
    for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) cells[r * nx + c]!.push(id);
  });

  const mark = new Uint32Array(boxes.length);
  let stamp = 0;
  const nextStamp = (): number => {
    stamp += 1;
    if (stamp >= 0xffffffff) { mark.fill(0); stamp = 1; }
    return stamp;
  };

  return {
    size: boxes.length,
    query(minX, minZ, maxX, maxZ) {
      const out: number[] = [];
      if (boxes.length === 0 || maxX < x0 || minX > x1 || maxZ < z0 || minZ > z1) return out;
      const s = nextStamp();
      const [c0, c1, r0, r1] = [colOf(minX), colOf(maxX), rowOf(minZ), rowOf(maxZ)];
      for (let r = r0; r <= r1; r += 1) {
        for (let c = c0; c <= c1; c += 1) {
          for (const id of cells[r * nx + c]!) {
            if (mark[id] === s) continue;
            mark[id] = s;
            const b = boxes[id]!;
            if (b.minX <= maxX && b.maxX >= minX && b.minZ <= maxZ && b.maxZ >= minZ) out.push(id);
          }
        }
      }
      return out.length > 1 ? out.sort((a, b) => a - b) : out;
    },
    along(ox, oz, dx, dz, limit, visit) {
      if (boxes.length === 0) return;
      // Clip the ray to the grid; a ray that never enters it has nothing to visit.
      let t0 = 0;
      let t1 = limit;
      for (const [o, d, lo, hi] of [[ox, dx, x0, x1], [oz, dz, z0, z1]] as const) {
        if (Math.abs(d) < 1e-12) {
          if (o < lo || o > hi) return;
          continue;
        }
        const a = (lo - o) / d;
        const b = (hi - o) / d;
        t0 = Math.max(t0, Math.min(a, b));
        t1 = Math.min(t1, Math.max(a, b));
        if (t0 > t1) return;
      }
      const px = ox + dx * t0;
      const pz = oz + dz * t0;
      let c = colOf(px);
      let r = rowOf(pz);
      const stepC = dx > 0 ? 1 : -1;
      const stepR = dz > 0 ? 1 : -1;
      const deltaC = Math.abs(dx) < 1e-12 ? Infinity : cell / Math.abs(dx);
      const deltaR = Math.abs(dz) < 1e-12 ? Infinity : cell / Math.abs(dz);
      let nextC = Math.abs(dx) < 1e-12 ? Infinity : t0 + ((dx > 0 ? x0 + (c + 1) * cell : x0 + c * cell) - px) / dx;
      let nextR = Math.abs(dz) < 1e-12 ? Infinity : t0 + ((dz > 0 ? z0 + (r + 1) * cell : z0 + r * cell) - pz) / dz;
      const s = nextStamp();
      let reach = limit;
      for (;;) {
        for (const id of cells[r * nx + c]!) {
          if (mark[id] === s) continue;
          mark[id] = s;
          reach = Math.min(reach, visit(id));
        }
        const leave = Math.min(nextC, nextR);
        if (leave > reach || leave > t1) return;
        if (nextC <= nextR) { c += stepC; nextC += deltaC; } else { r += stepR; nextR += deltaR; }
        if (c < 0 || c >= nx || r < 0 || r >= nz) return;
      }
    },
  };
}
