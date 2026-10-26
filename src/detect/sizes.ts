import { duTree } from "../scan/du.js";
import { ScanIndex, TopFiles, findExact } from "../scan/tree.js";

/**
 * Size of a path: from the index when it's indexed, otherwise measured live
 * (cheap, since anything not indexed is below the index threshold — or outside
 * the scanned root).
 */
export class Sizer {
  private cache = new Map<string, number>();
  constructor(private readonly index?: ScanIndex) {}

  async sizeOf(p: string): Promise<number> {
    const cached = this.cache.get(p);
    if (cached !== undefined) return cached;
    const node = this.index ? findExact(this.index.tree, p) : undefined;
    let size: number;
    if (node) size = node.size;
    else {
      const res = await duTree([p], { minNodeBytes: Number.MAX_SAFE_INTEGER, topFiles: new TopFiles(0, Infinity) });
      size = res.roots[0]?.size ?? 0;
    }
    this.cache.set(p, size);
    return size;
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
