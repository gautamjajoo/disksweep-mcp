/**
 * Sizing engine. Like OmniDiskSweeper it visits every file, but the walking is
 * done by a native helper and we only stream its post-order output, keeping
 * what matters: folders/files above a threshold plus the top-N largest files.
 * Memory stays small even for millions of files.
 *
 * Engine: native/bin/dsize (clone-aware: exact APFS clones counted once,
 * iCloud-only files count 0, getattrlistbulk). Falls back to the system `du`
 * (hard links once, one filesystem, but clones counted twice).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DSIZE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../native/bin/dsize");

export function sizingEngine(): { name: "dsize" | "du"; cmd: string; args: string[]; unit: number; mtime: boolean; sep: string } {
  if (process.env.DISKSWEEP_ENGINE !== "du" && fs.existsSync(DSIZE)) {
    return { name: "dsize", cmd: DSIZE, args: ["-m", "-0"], unit: 1, mtime: true, sep: "\0" };
  }
  // Fallback: du can't NUL-separate, so a file name containing a newline could
  // forge a record; consumers re-verify sizes on disk before trusting them.
  return { name: "du", cmd: "/usr/bin/du", args: ["-x", "-a", "-k"], unit: 1024, mtime: false, sep: "\n" };
}

/** Split a stream into records on `sep` (NUL for dsize -0, newline for du). */
export async function* records(stream: NodeJS.ReadableStream, sep: string): AsyncGenerator<string> {
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk.toString();
    let i: number;
    while ((i = buf.indexOf(sep)) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}
import { SizeNode, TopFiles, sortChildren } from "./tree.js";

/** On macOS the writable Data volume is firmlinked to /; show the familiar paths. */
const DATA_VOLUME = "/System/Volumes/Data";
export function displayPath(p: string): string {
  if (p === DATA_VOLUME) return "/";
  if (p.startsWith(DATA_VOLUME + "/")) return p.slice(DATA_VOLUME.length);
  return p;
}

export interface DuOptions {
  minNodeBytes: number;
  topFiles: TopFiles;
  onProgress?: (entries: number, current: string) => void;
  signal?: AbortSignal;
}

export interface DuResult {
  /** One node per root argument, in argument order. */
  roots: SizeNode[];
  denied: string[];
  entries: number;
}

interface Pending {
  children: SizeNode[];
}

/**
 * Size one or more roots. Each root becomes a SizeNode whose children are the
 * indexed (>= minNodeBytes) descendants.
 */
export function duTree(roots: string[], opts: DuOptions): Promise<DuResult> {
  return new Promise((resolve, reject) => {
    const engine = sizingEngine();
    const child = spawn(engine.cmd, [...engine.args, "--", ...roots], {
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });
    const rootSet = new Set(roots.map((r) => r.replace(/\/+$/, "") || "/"));
    const pending = new Map<string, Pending>();
    const results = new Map<string, SizeNode>();
    const denied: string[] = [];
    let entries = 0;

    const onRecord = (line: string) => {
      const tab = line.indexOf("\t");
      if (tab < 1) return;
      const amount = Number(line.slice(0, tab));
      let rest = line.slice(tab + 1);
      let mtime: number | undefined;
      if (engine.mtime) {
        const tab2 = rest.indexOf("\t");
        if (tab2 < 1) return;
        mtime = Number(rest.slice(0, tab2)) * 1000;
        rest = rest.slice(tab2 + 1);
      }
      const rawPath = rest;
      if (!Number.isFinite(amount)) return;
      entries++;
      if (opts.onProgress && entries % 20000 === 0) opts.onProgress(entries, displayPath(rawPath));

      const p = displayPath(rawPath);
      const size = amount * engine.unit;
      const own = pending.get(p);
      pending.delete(p);
      const isDir = own !== undefined;
      const node: SizeNode = { path: p, size };
      if (mtime) node.mtime = mtime;
      if (isDir) {
        if (own.children.length) {
          node.children = own.children;
          sortChildren(node);
        }
      } else {
        // A leaf: a file or an empty folder. Track large files.
        node.isFile = true;
        opts.topFiles.add({ path: p, size, mtime });
      }

      if (rootSet.has(p) || rootSet.has(rawPath)) {
        if (node.isFile && size === 0) delete node.isFile;
        results.set(p, node);
        return;
      }
      const parent = path.dirname(p);
      let bucket = pending.get(parent);
      if (!bucket) {
        bucket = { children: [] };
        pending.set(parent, bucket);
      }
      if (size >= opts.minNodeBytes) bucket.children.push(node);
    };
    const reading = (async () => {
      for await (const rec of records(child.stdout, engine.sep)) onRecord(rec);
    })();

    const errRl = readline.createInterface({ input: child.stderr });
    errRl.on("line", (line) => {
      // "du: /path: Permission denied" / "dsize: /path: Operation not permitted"
      const m = /^(?:du|dsize): (.*): (Permission denied|Operation not permitted)$/.exec(line);
      if (m) denied.push(displayPath(m[1]));
    });

    child.on("error", reject);
    child.on("close", async (code) => {
      await reading.catch(() => {});
      // Exit 1 means some folders were unreadable; that's expected.
      if (code !== 0 && code !== 1 && !opts.signal?.aborted) {
        reject(new Error(`${engine.name} exited with code ${code}`));
        return;
      }
      if (opts.signal?.aborted) {
        reject(new Error("scan cancelled"));
        return;
      }
      const ordered = roots.map((r) => {
        const key = displayPath(r.replace(/\/+$/, "") || "/");
        return results.get(key) ?? { path: key, size: 0 };
      });
      resolve({ roots: ordered, denied, entries });
    });
  });
}

/** Quick one-level listing for folders below the index threshold. */
export async function duShallow(dir: string): Promise<SizeNode> {
  const top = new TopFiles(0, Number.MAX_SAFE_INTEGER);
  const res = await duTree([dir], { minNodeBytes: 0, topFiles: top });
  const node = res.roots[0];
  // Collapse to one level for display.
  node.children = node.children?.map((c) => ({ path: c.path, size: c.size, isFile: c.isFile }));
  if (res.denied.length) node.partial = true;
  return node;
}
