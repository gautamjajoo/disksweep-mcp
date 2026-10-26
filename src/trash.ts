/**
 * Emptying old Trash items is the only permanent deletion disksweep performs.
 * Two steps: list (no confirm) then delete (confirm: true), and only direct
 * children of ~/.Trash that were put there more than N days ago.
 */
import fs from "node:fs";
import path from "node:path";
import { getPlatform } from "./platform/index.js";
import { formatBytes, describeAge } from "./format.js";
import { recordHistory } from "./memory.js";
import { duTree } from "./scan/du.js";
import { TopFiles } from "./scan/tree.js";

export interface TrashItem {
  path: string;
  size: number;
  trashedAt?: number;
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
    items.push({ path: p, size: res.roots[0]?.size ?? 0, trashedAt: added });
  }
  return { items: items.sort((a, b) => b.size - a.size) };
}

export async function emptyOldTrash(olderThanDays: number): Promise<{ removed: TrashItem[]; freed: number; errors: string[] }> {
  const dir = getPlatform().trashDir();
  const { items, error } = await listOldTrash(olderThanDays);
  if (error) return { removed: [], freed: 0, errors: [error] };
  const removed: TrashItem[] = [];
  const errors: string[] = [];
  for (const it of items) {
    // Only direct children of the real Trash folder; fs.rm does not follow symlinks.
    if (path.dirname(it.path) !== dir || (await fs.promises.realpath(path.dirname(it.path))) !== dir) {
      errors.push(`${it.path}: not directly in the Trash, skipped`);
      continue;
    }
    try {
      await fs.promises.rm(it.path, { recursive: true, force: true });
      removed.push(it);
    } catch (e) {
      errors.push(`${path.basename(it.path)}: ${(e as Error).message}`);
    }
  }
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
