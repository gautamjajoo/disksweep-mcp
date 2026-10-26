/**
 * Duplicate files in your own folders: size bucket -> head/tail hash -> full
 * hash. Copies that are APFS clones of each other share their blocks and waste
 * nothing, so wasted space is measured with dsize, not assumed.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatBytes } from "../format.js";
import { userHome } from "../paths.js";
import { checkPath } from "../safety/guard.js";
import { sizingEngine } from "../scan/du.js";
import { Candidate, candidateId } from "./types.js";

const run = promisify(execFile);
const LIBRARY_RE = /\.(photoslibrary|photolibrary|musiclibrary|tvlibrary|imovielibrary|fcpbundle)(\/|$)/;

async function listBigFiles(dirs: string[], minBytes: number, limit: number): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = [];
  const stack = [...dirs];
  while (stack.length && out.length < limit) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name === ".git" || e.name === "node_modules" || LIBRARY_RE.test(p + "/")) continue;
        stack.push(p);
      } else if (e.isFile()) {
        try {
          const st = await fs.promises.lstat(p);
          if (st.size >= minBytes) out.push({ path: p, size: st.size });
        } catch {
          /* vanished */
        }
      }
    }
  }
  return out;
}

async function hashPart(file: string, size: number): Promise<string> {
  const fh = await fs.promises.open(file, "r");
  try {
    const chunk = Math.min(1 << 20, size);
    const a = Buffer.alloc(chunk);
    const b = Buffer.alloc(chunk);
    await fh.read(a, 0, chunk, 0);
    await fh.read(b, 0, chunk, Math.max(0, size - chunk));
    return crypto.createHash("sha256").update(a).update(b).digest("hex");
  } finally {
    await fh.close();
  }
}

function hashFull(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

function groupBy<T>(items: T[], key: (t: T) => string): T[][] {
  const m = new Map<string, T[]>();
  for (const i of items) {
    const k = key(i);
    const g = m.get(k);
    if (g) g.push(i);
    else m.set(k, [i]);
  }
  return [...m.values()].filter((g) => g.length > 1);
}

/** Real extra bytes the copies use, beyond the first (clone-aware). */
async function wastedBytes(paths: string[], fallbackEach: number): Promise<number> {
  const engine = sizingEngine();
  if (engine.name !== "dsize") return fallbackEach * (paths.length - 1);
  const { stdout } = await run(engine.cmd, ["--", ...paths]);
  const sizes = stdout.trim().split("\n").map((l) => Number(l.split("\t")[0]));
  return sizes.slice(1).reduce((s, n) => s + n, 0);
}

export async function findDuplicates(
  dirs = ["Documents", "Downloads", "Desktop", "Movies", "Music", "Pictures"].map((d) => path.join(userHome(), d)),
  minBytes = 10 * 1000 * 1000,
  maxFiles = 20000,
): Promise<Candidate[]> {
  const files = await listBigFiles(dirs, minBytes, maxFiles);
  const out: Candidate[] = [];
  for (const sameSize of groupBy(files, (f) => String(f.size))) {
    const withHead = await Promise.all(sameSize.map(async (f) => ({ ...f, h: await hashPart(f.path, f.size).catch(() => "") })));
    for (const sameHead of groupBy(withHead.filter((f) => f.h), (f) => f.h)) {
      const withFull = await Promise.all(sameHead.map(async (f) => ({ ...f, h: await hashFull(f.path).catch(() => "") })));
      for (const group of groupBy(withFull.filter((f) => f.h), (f) => f.h)) {
        // Keep the oldest copy (most likely the "original"); suggest the rest.
        const dated = await Promise.all(group.map(async (f) => ({ ...f, t: (await fs.promises.lstat(f.path)).birthtimeMs })));
        dated.sort((a, b) => a.t - b.t);
        const [keep, ...extra] = dated;
        const removable = extra.filter((f) => checkPath(f.path).ok);
        if (!removable.length) continue;
        const wasted = await wastedBytes([keep.path, ...removable.map((f) => f.path)], keep.size);
        if (wasted < minBytes) continue; // clones of each other: nothing to gain
        out.push({
          id: candidateId("duplicate", removable.map((f) => f.path)),
          title: `${removable.length} duplicate(s) of ${path.basename(keep.path)}`,
          detector: "duplicate",
          category: "files",
          tier: "review",
          paths: removable.map((f) => f.path),
          size: wasted,
          reason: `Byte-for-byte identical copies (${formatBytes(keep.size)} each). The oldest copy stays at ${keep.path}.`,
        });
      }
    }
  }
  return out.sort((a, b) => b.size - a.size);
}
