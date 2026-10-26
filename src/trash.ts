/**
 * Emptying old Trash items is the only permanent deletion disksweep performs.
 * Two steps: list (returns a token for exactly what the user was shown), then
 * delete that list only, with confirm: true; direct children of ~/.Trash only.
 */
import fs from "node:fs";
import path from "node:path";
import { getPlatform } from "./platform/index.js";
import crypto from "node:crypto";
import { formatBytes, describeAge } from "./format.js";
import { dataPath, readJson, writeJson } from "./paths.js";
import { recordHistory } from "./memory.js";
import { duTree } from "./scan/du.js";
import { TopFiles } from "./scan/tree.js";

export interface TrashItem {
  path: string;
  size: number;
  ino?: number;
  trashedAt?: number;
}

interface ShownList {
  token: string;
  at: number;
  items: TrashItem[];
}

const LIST_TTL_MS = 15 * 60_000;
const listFile = () => dataPath("trash-list.json");

/** Remember exactly what the user was shown; emptying acts on this list only. */
export function rememberShownList(items: TrashItem[]): string {
  const token = `t${crypto.randomBytes(4).toString("hex")}`;
  writeJson(listFile(), { token, at: Date.now(), items } satisfies ShownList);
  return token;
}

export async function listOldTrash(olderThanDays: number): Promise<{ items: TrashItem[]; error?: string }> {
  const platform = getPlatform();
  const dir = platform.trashDir();
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      items: [],
      error:
        code === "EPERM" || code === "EACCES"
          ? "macOS blocked access to the Trash. Grant Full Disk Access to the app running disksweep (System Settings → Privacy & Security → Full Disk Access), or empty the Trash from Finder."
          : `Could not read the Trash: ${code}`,
    };
  }
  const items: TrashItem[] = [];
  for (const name of names) {
    if (name === ".DS_Store") continue;
    const p = path.join(dir, name);
    const added = (await platform.dateAdded(p))?.getTime() ?? (await fs.promises.lstat(p).catch(() => undefined))?.ctimeMs;
    if (added && Date.now() - added < olderThanDays * 86_400_000) continue;
    const res = await duTree([p], { minNodeBytes: Number.MAX_SAFE_INTEGER, topFiles: new TopFiles(0, Infinity) });
    const ino = (await fs.promises.lstat(p).catch(() => undefined))?.ino;
    items.push({ path: p, size: res.roots[0]?.size ?? 0, ino, trashedAt: added });
  }
  return { items: items.sort((a, b) => b.size - a.size) };
}

/** Permanently delete exactly the items of a list the user was shown (by token), if unchanged. */
export async function emptyShownTrash(token: string): Promise<{ removed: TrashItem[]; freed: number; errors: string[] }> {
  const shown = readJson<ShownList | undefined>(listFile(), undefined);
  if (!shown || shown.token !== token) {
    return { removed: [], freed: 0, errors: ["Unknown or replaced list token. Call list_old_trash again and show the user the new list."] };
  }
  if (Date.now() - shown.at > LIST_TTL_MS) {
    return { removed: [], freed: 0, errors: ["That list is more than 15 minutes old. Call list_old_trash again and show the user the new list."] };
  }
  const dir = getPlatform().trashDir();
  const removed: TrashItem[] = [];
  const errors: string[] = [];
  for (const it of shown.items) {
    // Only direct children of the real Trash folder, still the same file; fs.rm does not follow symlinks.
    if (path.dirname(it.path) !== dir || (await fs.promises.realpath(path.dirname(it.path)).catch(() => "")) !== dir) {
      errors.push(`${path.basename(it.path)}: not directly in the Trash, skipped`);
      continue;
    }
    const st = await fs.promises.lstat(it.path).catch(() => undefined);
    if (!st) continue; // already gone
    if (it.ino !== undefined && st.ino !== it.ino) {
      errors.push(`${path.basename(it.path)}: replaced by a different item since you saw the list, skipped`);
      continue;
    }
    try {
      await fs.promises.rm(it.path, { recursive: true, force: true });
      removed.push(it);
    } catch (e) {
      errors.push(`${path.basename(it.path)}: ${(e as Error).message}`);
    }
  }
  fs.rmSync(listFile(), { force: true }); // a list can be used once
  recordHistory(removed.map((r) => ({ at: Date.now(), path: r.path, size: r.size, title: path.basename(r.path), proposalId: "trash", action: "emptied-from-trash" as const })));
  return { removed, freed: removed.reduce((s, r) => s + r.size, 0), errors };
}

export function formatTrashList(items: TrashItem[], olderThanDays: number): string {
  if (!items.length) return `Nothing in the Trash older than ${olderThanDays} days.`;
  const total = items.reduce((s, i) => s + i.size, 0);
  return [
    `${items.length} item(s) in the Trash older than ${olderThanDays} days, ${formatBytes(total)} total. Emptying them is permanent.`,
    ...items.slice(0, 30).map((i) => `  ${formatBytes(i.size).padStart(8)}  ${path.basename(i.path)}  (trashed ${describeAge(i.trashedAt)})`),
    items.length > 30 ? `  …and ${items.length - 30} more` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
