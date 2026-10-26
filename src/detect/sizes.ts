import { duTree } from "../scan/du.js";
import { ScanIndex, TopFiles, findExact } from "../scan/tree.js";

/** Measure one path live: allocated size and newest modification inside. */
export async function measurePath(p: string): Promise<{ size: number; newest?: number }> {
  const res = await duTree([p], { minNodeBytes: Number.MAX_SAFE_INTEGER, topFiles: new TopFiles(0, Infinity) });
  return { size: res.roots[0]?.size ?? 0, newest: res.roots[0]?.mtime };
}

/**
 * Size of a path: from the index when it's indexed, otherwise measured live
 * (cheap, since anything not indexed is below the index threshold — or outside
 * the scanned root).
 */
export class Sizer {
  private cache = new Map<string, { size: number; newest?: number }>();
  constructor(private readonly index?: ScanIndex) {}

  /** Size and newest modification anywhere inside (a folder's own mtime only covers direct children). */
  async measure(p: string): Promise<{ size: number; newest?: number }> {
    const cached = this.cache.get(p);
    if (cached) return cached;
    const node = this.index ? findExact(this.index.tree, p) : undefined;
    let m: { size: number; newest?: number };
    if (node && node.mtime) m = { size: node.size, newest: node.mtime };
    else m = await measurePath(p);
    this.cache.set(p, m);
    return m;
  }

  async sizeOf(p: string): Promise<number> {
    return (await this.measure(p)).size;
  }

  /** Newest modification anywhere inside, when the index knows it. */
  newestInside(p: string): number | undefined {
    return this.index ? findExact(this.index.tree, p)?.mtime : undefined;
  }

  /** Cheap upper bound: if the deepest indexed ancestor is below `min`, so is p. */
  belowThreshold(p: string, min: number): boolean {
    if (!this.index) return false;
    const node = findExact(this.index.tree, p);
    if (node) return node.size < min;
    // Not indexed and inside the indexed root => smaller than the index threshold.
    const root = this.index.tree.path;
    const inside = root === "/" || p === root || p.startsWith(root + "/");
    return inside && this.index.minNodeBytes <= min;
  }
}
