/** Large files anywhere in your home, and things in Downloads/Desktop you haven't opened in ages. */
import fs from "node:fs";
import path from "node:path";
import { getPlatform } from "../platform/index.js";
import { describeAge, formatBytes } from "../format.js";
import { isWithin, userHome } from "../paths.js";
import { ScanIndex } from "../scan/tree.js";
import { Candidate, candidateId } from "./types.js";
import { Sizer } from "./sizes.js";

/**
 * Last time the user touched it: the later of when they last opened it
 * (Spotlight) and the newest change anywhere inside (for folders Spotlight only
 * tracks the folder itself being opened, which says little).
 */
export async function lastUse(p: string, newestInside?: number): Promise<number | undefined> {
  const platform = getPlatform();
  const used = (await platform.lastUsed(p)) ?? (await platform.dateAdded(p));
  let mtime: number | undefined;
  try {
    mtime = (await fs.promises.lstat(p)).mtimeMs;
  } catch {
    /* gone */
  }
  const times = [used?.getTime(), mtime, newestInside].filter((t): t is number => !!t);
  return times.length ? Math.max(...times) : undefined;
}

const ACTIVE_DAYS = 7;

export async function findLargeFiles(index: ScanIndex, claimed: string[], minBytes: number): Promise<Candidate[]> {
  const home = userHome();
  const out: Candidate[] = [];
  for (const f of index.topFiles) {
    if (f.size < minBytes) break;
    if (!isWithin(f.path, home)) continue;
    if (claimed.some((c) => isWithin(f.path, c))) continue;
    // Trust the disk, not the index: the size must really be there.
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(f.path);
    } catch {
      continue;
    }
    if (!st.isFile() || st.blocks * 512 < minBytes) continue;
    const used = await lastUse(f.path);
    // A file changed in the last week is in active use (a live database, a VM disk…).
    if (used && Date.now() - used < ACTIVE_DAYS * 86_400_000) continue;
    out.push({
      id: candidateId("large-file", [f.path]),
      title: `Large file: ${path.basename(f.path)}`,
      detector: "large-file",
      category: "files",
      tier: "review",
      paths: [f.path],
      size: f.size,
      reason: `A single ${formatBytes(f.size)} file, last opened ${describeAge(used)}.`,
      lastUsed: used,
    });
  }
  return out;
}

export async function findStaleDownloads(
  sizer: Sizer,
  claimed: string[],
  staleDays: number,
  minBytes: number,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const folder of ["Downloads", "Desktop"]) {
    const dir = path.join(userHome(), folder);
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const p = path.join(dir, name);
      if (claimed.some((c) => isWithin(p, c) || isWithin(c, p))) continue;
      if (sizer.belowThreshold(p, minBytes)) continue;
      const size = await sizer.sizeOf(p);
      if (size < minBytes) continue;
      const used = await lastUse(p, sizer.newestInside(p));
      if (used && Date.now() - used < staleDays * 86_400_000) continue;
      const installer = /\.(dmg|pkg|iso|xip)$/i.test(name);
      out.push({
        id: candidateId("stale-download", [p]),
        title: `${folder}: ${name}`,
        detector: "stale-download",
        category: "files",
        tier: "review",
        paths: [p],
        size,
        reason: installer
          ? `An installer last opened ${describeAge(used)}. Once the app is installed, the installer is usually not needed.`
          : `In ${folder} and not opened since ${describeAge(used)}.`,
        lastUsed: used,
      });
    }
  }
  return out;
}
