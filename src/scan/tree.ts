import path from "node:path";

/** A folder (or large file) in the size index. Paths are absolute. */
export interface SizeNode {
  path: string;
  /** Allocated (on-disk) bytes, hard links counted once. */
  size: number;
  isFile?: boolean;
  /** Indexed children: folders and files >= the index threshold, largest first. */
  children?: SizeNode[];
  /** Newest modification time anywhere inside (ms), when the engine reports it. */
  mtime?: number;
  /** Some contents could not be read (permissions): size is a lower bound. */
  partial?: boolean;
}

export interface FileEntry {
  path: string;
  size: number;
  mtime?: number;
}

export interface ScanIndex {
  version: 1;
  root: string;
  scannedAt: number;
  durationMs: number;
  mode: "full" | "incremental";
  /** FSEvents id captured at the start of the scan, for incremental rescans. */
  eventId?: string;
  minNodeBytes: number;
  tree: SizeNode;
  topFiles: FileEntry[];
  /** Folders du could not read. */
  denied: string[];
}

export function sortChildren(node: SizeNode): void {
  node.children?.sort((a, b) => b.size - a.size);
}

/** Deepest indexed node that is `target` or an ancestor of it. */
export function findDeepest(tree: SizeNode, target: string): { node: SizeNode; chain: SizeNode[] } | undefined {
  if (!isAncestorOrSelf(tree.path, target)) return undefined;
  const chain: SizeNode[] = [tree];
  let node = tree;
  for (;;) {
    const next = node.children?.find((c) => !c.isFile && isAncestorOrSelf(c.path, target));
    if (!next) return { node, chain };
    chain.push(next);
    node = next;
  }
}

export function findExact(tree: SizeNode, target: string): SizeNode | undefined {
  const hit = findDeepest(tree, target);
  return hit && hit.node.path === target ? hit.node : undefined;
}

export function isAncestorOrSelf(ancestor: string, p: string): boolean {
  if (ancestor === p) return true;
  const prefix = ancestor === "/" ? "/" : ancestor + "/";
  return p.startsWith(prefix);
}

export function* walkTree(node: SizeNode, depth = 0): Generator<{ node: SizeNode; depth: number }> {
  yield { node, depth };
  for (const c of node.children ?? []) yield* walkTree(c, depth + 1);
}

/** Keep the N largest files. Small and simple: a sorted array with a floor. */
export class TopFiles {
  private items: FileEntry[] = [];
  constructor(private readonly limit: number, private readonly minBytes: number) {}

  add(entry: FileEntry): void {
    if (entry.size < this.minBytes) return;
    if (this.items.length >= this.limit && entry.size <= this.items[this.items.length - 1].size) return;
    this.items.push(entry);
    this.items.sort((a, b) => b.size - a.size);
    if (this.items.length > this.limit) this.items.pop();
  }

  removeUnder(dir: string): void {
    this.items = this.items.filter((f) => !isAncestorOrSelf(dir, f.path));
  }

  list(): FileEntry[] {
    return [...this.items];
  }

  static from(items: FileEntry[], limit: number, minBytes: number): TopFiles {
    const t = new TopFiles(limit, minBytes);
    for (const i of items) t.add(i);
    return t;
  }
}

export const parentOf = (p: string): string => path.dirname(p);
