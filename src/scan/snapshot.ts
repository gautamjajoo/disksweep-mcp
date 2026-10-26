/**
 * One compact size snapshot per day. Diffing snapshots answers "what grew?",
 * which finds space hogs no rule knows about.
 */
import fs from "node:fs";
import path from "node:path";
import { dataPath, readJson, writeJson } from "../paths.js";
import { ScanIndex, walkTree } from "./tree.js";

const KEEP_DAYS = 120;
const SNAPSHOT_MIN = 50 * 1000 * 1000;

interface Snapshot {
  date: string;
  takenAt: number;
  sizes: Record<string, number>;
}

const dir = () => path.dirname(dataPath("snapshots", "x"));
/** Local calendar day (a scan at 11:45 pm belongs to today, not to UTC's tomorrow). */
const day = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function saveSnapshot(idx: ScanIndex): void {
  const sizes: Record<string, number> = {};
  for (const { node } of walkTree(idx.tree)) {
    if (!node.isFile && node.size >= SNAPSHOT_MIN) sizes[node.path] = node.size;
  }
  const snap: Snapshot = { date: day(idx.scannedAt), takenAt: idx.scannedAt, sizes };
  writeJson(path.join(dir(), `${snap.date}.json`), snap);
  prune();
}

function prune(): void {
  const cutoff = day(Date.now() - KEEP_DAYS * 86_400_000);
  for (const f of fs.readdirSync(dir())) {
    if (f.endsWith(".json") && f.slice(0, 10) < cutoff) fs.rmSync(path.join(dir(), f), { force: true });
  }
}

function listSnapshots(): string[] {
  return fs
    .readdirSync(dir())
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
}

export interface Growth {
  path: string;
  before: number;
  after: number;
  delta: number;
}

/**
 * Folders that grew most between the latest snapshot and the one closest to
 * `days` ago. Reports the deepest folders responsible, not every ancestor.
 */
export function growthOver(days: number, limit = 15): { since?: string; items: Growth[] } {
  const files = listSnapshots();
  if (files.length < 2) return { items: [] };
  const latest = readJson<Snapshot>(path.join(dir(), files[files.length - 1]), { date: "", takenAt: 0, sizes: {} });
  const target = day(latest.takenAt - days * 86_400_000);
  const baseFile = [...files].reverse().find((f) => f.slice(0, 10) <= target) ?? files[0];
  if (baseFile === files[files.length - 1]) return { items: [] };
  const base = readJson<Snapshot>(path.join(dir(), baseFile), { date: "", takenAt: 0, sizes: {} });

  const grown: Growth[] = [];
  for (const [p, after] of Object.entries(latest.sizes)) {
    const before = base.sizes[p] ?? 0;
    const delta = after - before;
    if (delta >= SNAPSHOT_MIN) grown.push({ path: p, before, after, delta });
  }
  // Drop an ancestor when one child explains most (>= 70%) of its growth.
  const result = grown.filter(
    (g) =>
      !grown.some(
        (o) => o !== g && o.path.startsWith(g.path === "/" ? "/" : g.path + "/") && o.delta >= 0.7 * g.delta,
      ),
  );
  result.sort((a, b) => b.delta - a.delta);
  return { since: base.date, items: result.slice(0, limit) };
}
