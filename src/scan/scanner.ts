import fs from "node:fs";
import path from "node:path";
import { dataPath, readJson, writeJson } from "../paths.js";
import { loadConfig } from "../config.js";
import { tryLock } from "../lock.js";
import { duTree, displayPath } from "./du.js";
import { changesSince, currentEventId } from "./fsevents.js";
import { saveSnapshot } from "./snapshot.js";
import { ScanIndex, SizeNode, TopFiles, findDeepest, isAncestorOrSelf, sortChildren } from "./tree.js";

const TOP_FILES = 200;
const TOP_FILE_MIN = 50 * 1000 * 1000;

const indexFile = () => dataPath("index.json");

export function loadIndex(): ScanIndex | undefined {
  const idx = readJson<ScanIndex | undefined>(indexFile(), undefined);
  return idx?.version === 1 ? idx : undefined;
}

function saveIndex(idx: ScanIndex): void {
  writeJson(indexFile(), idx);
}

/** The volume to scan: the whole data volume on macOS, like OmniDiskSweeper. */
export function defaultScanRoot(): string {
  const cfg = loadConfig();
  if (cfg.scanRoot) return cfg.scanRoot;
  return fs.existsSync("/System/Volumes/Data") ? "/System/Volumes/Data" : path.parse(process.cwd()).root;
}

export interface ScanJob {
  id: number;
  mode: "full" | "incremental";
  root: string;
  startedAt: number;
  finishedAt?: number;
  entries: number;
  current?: string;
  error?: string;
  note?: string;
  promise: Promise<ScanIndex>;
  controller: AbortController;
}

let job: ScanJob | undefined;
let jobCounter = 0;

export function currentJob(): ScanJob | undefined {
  return job;
}

/**
 * Start (or join) a scan. Incremental mode falls back to a full scan when there
 * is no previous index, the root changed, or the change journal can't be trusted.
 */
export function startScan(mode: "full" | "incremental" = "incremental", root = defaultScanRoot()): ScanJob {
  if (job && !job.finishedAt) return job;
  const controller = new AbortController();
  const j: ScanJob = {
    id: ++jobCounter,
    mode,
    root,
    startedAt: Date.now(),
    entries: 0,
    controller,
    promise: Promise.resolve(undefined as never),
  };
  j.promise = runScan(j).then(
    (idx) => {
      j.finishedAt = Date.now();
      return idx;
    },
    (err: Error) => {
      j.finishedAt = Date.now();
      j.error = err.message;
      throw err;
    },
  );
  j.promise.catch(() => {}); // surfaced through status, not as unhandled rejection
  job = j;
  return j;
}

async function runScan(j: ScanJob): Promise<ScanIndex> {
  // One scan at a time across every process (Claude Code, Codex, cron report…).
  const lock = tryLock("scan", `${j.mode} scan of ${j.root}`);
  if (!lock.ok) {
    const secs = Math.round((Date.now() - lock.holder.since) / 1000);
    throw new Error(
      `another disksweep process (pid ${lock.holder.pid}) has been running a ${lock.holder.what} for ${secs}s. It saves to the same index; check disk_overview again in a minute instead of scanning twice.`,
    );
  }
  try {
    return await runScanLocked(j);
  } finally {
    lock.release();
  }
}

async function runScanLocked(j: ScanJob): Promise<ScanIndex> {
  const previous = loadIndex();
  const displayRoot = displayPath(j.root);
  if (j.mode === "incremental") {
    if (!previous || previous.root !== displayRoot || !previous.eventId) {
      j.mode = "full";
      j.note = previous ? "no usable change journal position; doing a full scan" : "first scan; doing a full scan";
    } else {
      const changes = await changesSince(j.root, previous.eventId);
      if (changes.mustFullScan) {
        j.mode = "full";
        j.note = `${changes.reason}; doing a full scan`;
      } else {
        const idx = await incremental(j, previous, changes.dirs);
        saveIndex(idx);
        saveSnapshot(idx);
        return idx;
      }
    }
  }
  const idx = await full(j);
  saveIndex(idx);
  saveSnapshot(idx);
  return idx;
}

async function full(j: ScanJob): Promise<ScanIndex> {
  const cfg = loadConfig();
  const eventId = await currentEventId();
  const top = new TopFiles(TOP_FILES, TOP_FILE_MIN);
  const res = await duTree([j.root], {
    minNodeBytes: cfg.minNodeBytes,
    topFiles: top,
    signal: j.controller.signal,
    onProgress: (n, cur) => {
      j.entries = n;
      j.current = cur;
    },
  });
  j.entries = res.entries;
  const tree = res.roots[0];
  markPartial(tree, res.denied);
  return {
    version: 1,
    root: displayPath(j.root),
    scannedAt: Date.now(),
    durationMs: Date.now() - j.startedAt,
    mode: "full",
    eventId,
    minNodeBytes: cfg.minNodeBytes,
    tree,
    topFiles: top.list(),
    denied: res.denied.slice(0, 500),
  };
}

/**
 * Re-size only what changed. For each changed folder we find the deepest
 * indexed folder N containing it and re-size N's contents, reusing the stored
 * totals of N's indexed subfolders that did not change themselves. Deepest
 * first, so updated child totals flow upward.
 */
async function incremental(j: ScanJob, prev: ScanIndex, changed: Set<string>): Promise<ScanIndex> {
  const eventId = await currentEventId();
  const tree = prev.tree;
  const top = TopFiles.from(prev.topFiles, TOP_FILES, TOP_FILE_MIN);
  const denied = new Set(prev.denied);

  // Map each changed folder to the deepest indexed folder that still exists.
  const targets = new Map<string, SizeNode[]>();
  for (let dir of changed) {
    if (!isAncestorOrSelf(tree.path, dir)) continue;
    while (dir !== tree.path && !fs.existsSync(dir)) dir = path.dirname(dir);
    const hit = findDeepest(tree, dir);
    if (hit) targets.set(hit.node.path, hit.chain);
  }
  // Deepest first.
  const ordered = [...targets.values()].sort((a, b) => b.length - a.length);

  for (const chain of ordered) {
    if (j.controller.signal.aborted) throw new Error("scan cancelled");
    const node = chain[chain.length - 1];
    const before = node.size;
    j.current = node.path;
    await resizeNode(node, prev.minNodeBytes, top, denied, j);
    const delta = node.size - before;
    for (const anc of chain.slice(0, -1)) {
      anc.size += delta;
      if (node.mtime && (!anc.mtime || node.mtime > anc.mtime)) anc.mtime = node.mtime;
      sortChildren(anc);
    }
  }

  return {
    ...prev,
    scannedAt: Date.now(),
    durationMs: Date.now() - j.startedAt,
    mode: "incremental",
    eventId: eventId ?? undefined,
    tree,
    topFiles: top.list(),
    denied: [...denied].slice(0, 500),
  };
}

async function resizeNode(
  node: SizeNode,
  minNodeBytes: number,
  top: TopFiles,
  denied: Set<string>,
  j: ScanJob,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(node.path, { withFileTypes: true });
  } catch {
    node.partial = true;
    return;
  }
  const keep = new Map<string, SizeNode>();
  for (const c of node.children ?? []) {
    // Indexed subfolders keep their stored totals: any that changed themselves
    // were re-sized earlier (deepest first), so those totals are fresh.
    if (!c.isFile) keep.set(c.path, c);
  }
  const toSize: string[] = [];
  const reused: SizeNode[] = [];
  for (const e of entries) {
    const p = path.join(node.path, e.name);
    const indexed = keep.get(p);
    if (indexed && fs.existsSync(p)) reused.push(indexed);
    else toSize.push(p);
  }
  for (const p of toSize) top.removeUnder(p);
  for (const d of [...denied]) if (toSize.some((p) => isAncestorOrSelf(p, d))) denied.delete(d);

  const sized: SizeNode[] = [];
  for (let i = 0; i < toSize.length; i += 400) {
    const batch = toSize.slice(i, i + 400);
    const res = await duTree(batch, { minNodeBytes, topFiles: top, signal: j.controller.signal });
    j.entries += res.entries;
    sized.push(...res.roots);
    for (const d of res.denied) denied.add(d);
  }
  let ownBytes = 0;
  let latest = 0;
  try {
    const st = await fs.promises.lstat(node.path);
    ownBytes = st.blocks * 512;
    latest = st.mtimeMs;
  } catch {
    /* ignore */
  }
  for (const c of [...reused, ...sized]) if (c.mtime && c.mtime > latest) latest = c.mtime;
  if (latest) node.mtime = latest;
  node.size = ownBytes + reused.reduce((s, c) => s + c.size, 0) + sized.reduce((s, c) => s + c.size, 0);
  node.children = [...reused, ...sized.filter((c) => c.size >= minNodeBytes)];
  if (node.children.length === 0) delete node.children;
  sortChildren(node);
}

function markPartial(tree: SizeNode, denied: string[]): void {
  for (const d of denied) {
    const hit = findDeepest(tree, d);
    if (hit) for (const n of hit.chain) n.partial = true;
  }
}

/** Wait up to `ms` for the job; returns the index if it finished. */
export async function waitForJob(j: ScanJob, ms: number): Promise<ScanIndex | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((r) => {
    timer = setTimeout(() => r(undefined), ms);
  });
  try {
    return await Promise.race([j.promise.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
