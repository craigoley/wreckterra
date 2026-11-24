/**
 * A uniform grid over a district: items are filed under every cell their box touches, so a query
 * looks only at the cells it covers instead of at every building or street segment in the city.
 * Pure data and arithmetic; no clock, no randomness, so results replay exactly.
 */
export interface IndexBounds { minX: number; maxX: number; minZ: number; maxZ: number }

export interface SpatialIndex {
  /** File an item under every cell its box touches. Items are small non-negative integers. */
  insert(id: number, minX: number, minZ: number, maxX: number, maxZ: number): void;
  /** Visit each item filed under the cells a box covers, once, in no particular order. */
  query(minX: number, minZ: number, maxX: number, maxZ: number, visit: (id: number) => void): void;
  /** The ids filed under the cells a box covers, ascending: the order a full scan would give. */
  collect(minX: number, minZ: number, maxX: number, maxZ: number): number[];
  /**
   * Walk the cells a ray crosses, nearest first, visiting each item once. `visit` returns the
   * distance beyond which nothing can matter any more (the nearest hit so far), and the walk
   * stops as soon as the next cell starts past it.
   */
  ray(ox: number, oz: number, dx: number, dz: number, limit: number, visit: (id: number) => number): void;
  /** The item with the smallest `distanceTo`, searching outward ring by ring, or null when empty. */
  nearest(x: number, z: number, distanceTo: (id: number) => number): { id: number; distance: number } | null;
  /** How many cells the grid holds. */
  readonly cells: number;
}

/** No grid is allowed more cells than this: a huge district gets bigger cells instead. */
const MAX_CELLS = 250_000;

export function createSpatialIndex(bounds: IndexBounds, cellSize: number, capacity: number = 0): SpatialIndex {
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const depth = Math.max(1, bounds.maxZ - bounds.minZ);
  const size = Math.max(cellSize, Math.sqrt((width * depth) / MAX_CELLS));
  const cols = Math.floor(width / size) + 1;
  const rows = Math.floor(depth / size) + 1;
  const buckets: (number[] | undefined)[] = new Array<number[] | undefined>(cols * rows);
  // A visit stamp per item makes "once per query" free of any set allocation.
  const stamps: number[] = new Array<number>(Math.max(0, capacity)).fill(0);
  let stamp = 0;
  let count = 0;

  const colOf = (x: number): number => Math.max(0, Math.min(cols - 1, Math.floor((x - bounds.minX) / size)));
  const rowOf = (z: number): number => Math.max(0, Math.min(rows - 1, Math.floor((z - bounds.minZ) / size)));

  const nextStamp = (): number => {
    stamp += 1;
    return stamp;
  };
  const seenBefore = (id: number, mark: number): boolean => {
    if (stamps[id] === mark) return true;
    stamps[id] = mark;
    return false;
  };

  const query: SpatialIndex["query"] = (minX, minZ, maxX, maxZ, visit) => {
    const mark = nextStamp();
    const c1 = colOf(maxX);
    const r1 = rowOf(maxZ);
    for (let r = rowOf(minZ); r <= r1; r += 1) {
      for (let c = colOf(minX); c <= c1; c += 1) {
        const bucket = buckets[r * cols + c];
        if (!bucket) continue;
        for (const id of bucket) if (!seenBefore(id, mark)) visit(id);
      }
    }
  };

  return {
    cells: cols * rows,
    insert(id, minX, minZ, maxX, maxZ) {
      count += 1;
      const c1 = colOf(maxX);
      const r1 = rowOf(maxZ);
      for (let r = rowOf(minZ); r <= r1; r += 1) {
        for (let c = colOf(minX); c <= c1; c += 1) {
          const at = r * cols + c;
          (buckets[at] ??= []).push(id);
        }
      }
    },
    query,
    collect(minX, minZ, maxX, maxZ) {
      const out: number[] = [];
      query(minX, minZ, maxX, maxZ, (id) => out.push(id));
      return out.sort((a, b) => a - b);
    },
    ray(ox, oz, dx, dz, limit, visit) {
      const outside = ox < bounds.minX || ox > bounds.maxX || oz < bounds.minZ || oz > bounds.maxZ;
      if (outside) {
        // Cells are only walked from inside the grid; from outside, fall back to the ray's box.
        const far = Number.isFinite(limit) ? limit : width + depth;
        query(Math.min(ox, ox + dx * far), Math.min(oz, oz + dz * far), Math.max(ox, ox + dx * far), Math.max(oz, oz + dz * far), (id) => {
          visit(id);
        });
        return;
      }
      const mark = nextStamp();
      let reach = limit;
      let c = colOf(ox);
      let r = rowOf(oz);
      const stepC = dx > 0 ? 1 : -1;
      const stepR = dz > 0 ? 1 : -1;
      // Distance along the ray to the next vertical and horizontal cell edge, and between edges.
      const nextX = bounds.minX + (c + (dx > 0 ? 1 : 0)) * size;
      const nextZ = bounds.minZ + (r + (dz > 0 ? 1 : 0)) * size;
      let tX = Math.abs(dx) < 1e-12 ? Infinity : (nextX - ox) / dx;
      let tZ = Math.abs(dz) < 1e-12 ? Infinity : (nextZ - oz) / dz;
      const deltaX = Math.abs(dx) < 1e-12 ? Infinity : size / Math.abs(dx);
      const deltaZ = Math.abs(dz) < 1e-12 ? Infinity : size / Math.abs(dz);
      for (let guard = cols + rows + 2; guard > 0; guard -= 1) {
        const bucket = buckets[r * cols + c];
        if (bucket) for (const id of bucket) if (!seenBefore(id, mark)) reach = Math.min(reach, visit(id));
        if (Math.min(tX, tZ) > reach) return;
        if (tX < tZ) {
          c += stepC;
          tX += deltaX;
        } else {
          r += stepR;
          tZ += deltaZ;
        }
        if (c < 0 || c >= cols || r < 0 || r >= rows) return;
      }
    },
    nearest(x, z, distanceTo) {
      if (count === 0) return null;
      let best: { id: number; distance: number } | null = null;
      const mark = nextStamp();
      const c0 = colOf(x);
      const r0 = rowOf(z);
      const rings = Math.max(cols, rows);
      for (let ring = 0; ring <= rings; ring += 1) {
        // Everything not yet seen is at least this far away: the inner rings' outer edge.
        if (best && best.distance <= (ring - 1) * size) break;
        for (let r = r0 - ring; r <= r0 + ring; r += 1) {
          if (r < 0 || r >= rows) continue;
          const edgeRow = r === r0 - ring || r === r0 + ring;
          for (let c = c0 - ring; c <= c0 + ring; c += edgeRow ? 1 : Math.max(1, 2 * ring)) {
            if (c < 0 || c >= cols) continue;
            const bucket = buckets[r * cols + c];
            if (!bucket) continue;
            for (const id of bucket) {
              if (seenBefore(id, mark)) continue;
              const distance = distanceTo(id);
              if (!best || distance < best.distance) best = { id, distance };
            }
          }
        }
      }
      return best;
    },
  };
}
