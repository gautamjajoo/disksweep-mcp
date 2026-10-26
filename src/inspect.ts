/**
 * Investigate an unfamiliar folder or file so the assistant can work out what
 * it is and whether it's safe to remove. Read-only and metadata-only: file
 * names, sizes, types, ages and ownership — never file contents.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import readline from "node:readline";
import { promisify } from "node:util";
import { getPlatform } from "./platform/index.js";
import { describeAge, formatBytes } from "./format.js";
import { isWithin, tildify, userHome } from "./paths.js";
import { assertSafe } from "./safety/guard.js";
import { sizingEngine } from "./scan/du.js";
import { installedApps, ownerOf } from "./detect/apps.js";
import { loadRules, expandPattern } from "./detect/rules.js";
import { lastCleaned, noteFor } from "./memory.js";

const run = promisify(execFile);

export interface InspectResult {
  path: string;
  kind: "folder" | "file" | "missing";
  size: number;
  complete: boolean;
  files: number;
  folders: number;
  lastActivity?: number;
  /** Bytes by how long ago files were last modified. */
  age: { label: string; bytes: number; files: number }[];
  types: { ext: string; bytes: number; files: number }[];
  children: { name: string; size: number; lastActivity?: number; isFile: boolean }[];
  largestFiles: { path: string; size: number; modified?: number }[];
  recentFiles: { path: string; modified: number }[];
  signals: string[];
  owner?: { app: string; appPath: string; running: boolean };
  matchingRule?: { id: string; name: string; tier: string };
  note?: string;
  decision?: string;
  grewBack?: { cleanedAt: number; sizeThen: number };
  downloadedFrom?: string[];
  actionable: boolean;
  protectedReason?: string;
}

const AGE_BUCKETS: [string, number][] = [
  ["last 7 days", 7],
  ["7-30 days", 30],
  ["1-6 months", 182],
  ["6-12 months", 365],
  ["over a year", Infinity],
];

const DB_EXT = new Set(["sqlite", "sqlite3", "db", "realm", "ldb", "leveldb", "sqlite-wal", "wal"]);

function extOf(p: string): string {
  const base = path.basename(p);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1 || base.length - dot > 12) return "(none)";
  return base.slice(dot + 1).toLowerCase();
}

/** Walk with dsize -m (or du) and aggregate; stops at the time limit and reports partial stats. */
async function walk(target: string, timeLimitMs: number) {
  const engine = sizingEngine();
  const args = engine.name === "dsize" ? ["-m", "--", target] : ["-x", "-a", "-k", "--", target];
  const child = spawn(engine.cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
  const timer = setTimeout(() => child.kill(), timeLimitMs);
  const now = Date.now();
  const stats = {
    total: 0,
    files: 0,
    folders: 0,
    complete: true,
    age: AGE_BUCKETS.map(([label]) => ({ label, bytes: 0, files: 0 })),
    types: new Map<string, { bytes: number; files: number }>(),
    children: new Map<string, { size: number; lastActivity?: number; isFile: boolean }>(),
    largest: [] as { path: string; size: number; modified?: number }[],
    recent: [] as { path: string; modified: number }[],
    dirs: new Set<string>(),
    names: new Set<string>(),
  };
  const rl = readline.createInterface({ input: child.stdout! });
  for await (const line of rl) {
    const parts = line.split("\t");
    let size: number, mtime: number | undefined, p: string;
    if (engine.name === "dsize") {
      if (parts.length < 3) continue;
      size = Number(parts[0]);
      mtime = Number(parts[1]) * 1000;
      p = parts.slice(2).join("\t");
    } else {
      size = Number(parts[0]) * 1024;
      p = parts.slice(1).join("\t");
    }
    if (p === target) {
      stats.total = size;
      continue;
    }
    const parent = path.dirname(p);
    const isDir = stats.dirs.has(p);
    stats.dirs.add(parent);
    if (parent === target) stats.children.set(path.basename(p), { size, lastActivity: mtime, isFile: !isDir });
    if (isDir) {
      stats.folders++;
      continue;
    }
    // A file (or empty folder).
    stats.files++;
    if (stats.names.size < 4000) stats.names.add(path.basename(p).toLowerCase());
    const ext = extOf(p);
    const t = stats.types.get(ext) ?? { bytes: 0, files: 0 };
    t.bytes += size;
    t.files++;
    stats.types.set(ext, t);
    if (mtime) {
      const days = (now - mtime) / 86_400_000;
      const idx = AGE_BUCKETS.findIndex(([, max]) => days < max);
      stats.age[idx].bytes += size;
      stats.age[idx].files++;
      stats.recent.push({ path: p, modified: mtime });
      if (stats.recent.length > 40) {
        stats.recent.sort((a, b) => b.modified - a.modified);
        stats.recent.length = 10;
      }
    }
    stats.largest.push({ path: p, size, modified: mtime });
    if (stats.largest.length > 40) {
      stats.largest.sort((a, b) => b.size - a.size);
      stats.largest.length = 10;
    }
  }
  clearTimeout(timer);
  if (child.killed) stats.complete = false;
  if (!stats.total) stats.total = [...stats.children.values()].reduce((s, c) => s + c.size, 0);
  // Children found after the walk was cut short may be folders reported as files; fine for display.
  for (const [name, c] of stats.children) if (stats.dirs.has(path.join(target, name))) c.isFile = false;
  stats.largest.sort((a, b) => b.size - a.size);
  stats.recent.sort((a, b) => b.modified - a.modified);
  return stats;
}

function signalsFrom(target: string, names: Set<string>, types: Map<string, { bytes: number; files: number }>, total: number): string[] {
  const s: string[] = [];
  const rel = isWithin(target, userHome()) ? path.relative(userHome(), target) : target;
  if (/^Library\/Caches(\/|$)/.test(rel)) s.push("Lives in ~/Library/Caches, where macOS apps keep disposable cache data.");
  if (/^Library\/Logs(\/|$)/.test(rel)) s.push("Lives in ~/Library/Logs (diagnostic logs).");
  if (/^Library\/Application Support(\/|$)/.test(rel)) s.push("Lives in ~/Library/Application Support, where apps keep their working data (can include user data).");
  if (/^Library\/Containers(\/|$)/.test(rel)) s.push("A sandboxed app's container (its private Library).");
  if (/(^|\/)(cache|caches|tmp|temp|\.cache)(\/|$)/i.test(rel)) s.push("Path contains a cache/temp folder name.");
  if (names.has(".git") || names.has("head")) s.push("Contains git data: may hold unpushed work.");
  if (["package.json", "cargo.toml", "pyproject.toml", "go.mod", "pom.xml"].some((n) => names.has(n))) s.push("Contains source-code project files.");
  const dbBytes = [...types].filter(([e]) => DB_EXT.has(e)).reduce((a, [, v]) => a + v.bytes, 0);
  if (dbBytes > 0) s.push(`Contains databases (${formatBytes(dbBytes)}): likely an app's own state (history, settings, indexes).`);
  const top = [...types].sort((a, b) => b[1].bytes - a[1].bytes)[0];
  if (top && total > 0 && top[1].bytes / total > 0.6) s.push(`Mostly .${top[0]} files (${Math.round((top[1].bytes / total) * 100)}% of the space).`);
  const media = ["mp4", "mov", "m4a", "wav", "mp3", "jpg", "jpeg", "heic", "png", "webm", "aac", "opus"];
  const mediaBytes = [...types].filter(([e]) => media.includes(e)).reduce((a, [, v]) => a + v.bytes, 0);
  if (total > 0 && mediaBytes / total > 0.3) s.push(`Holds media (audio/video/images): ${formatBytes(mediaBytes)}. Could be recordings the user cares about.`);
  return s;
}

async function whereFrom(file: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await run("/usr/bin/mdls", ["-raw", "-name", "kMDItemWhereFroms", file]);
    const urls = [...stdout.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    return urls.length ? urls : undefined;
  } catch {
    return undefined;
  }
}

export async function inspect(target: string, timeLimitMs = 20_000): Promise<InspectResult> {
  const platform = getPlatform();
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(target);
  } catch {
    return {
      path: target, kind: "missing", size: 0, complete: true, files: 0, folders: 0, age: [], types: [], children: [],
      largestFiles: [], recentFiles: [], signals: [], actionable: false, protectedReason: "does not exist",
    };
  }
  const isDir = st.isDirectory() && !target.endsWith(".app");
  const w = isDir || target.endsWith(".app") ? await walk(target, timeLimitMs) : undefined;

  const result: InspectResult = {
    path: target,
    kind: st.isDirectory() ? "folder" : "file",
    size: w?.total ?? st.blocks * 512,
    complete: w?.complete ?? true,
    files: w?.files ?? 1,
    folders: w?.folders ?? 0,
    lastActivity: w ? Math.max(st.mtimeMs, ...w.recent.slice(0, 1).map((r) => r.modified)) : st.mtimeMs,
    age: w?.age.filter((a) => a.files) ?? [],
    types: w
      ? [...w.types].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 12).map(([ext, v]) => ({ ext, ...v }))
      : [],
    children: w
      ? [...w.children].sort((a, b) => b[1].size - a[1].size).slice(0, 25).map(([name, v]) => ({ name, ...v }))
      : [],
    largestFiles: w?.largest.slice(0, 10) ?? [],
    recentFiles: w?.recent.slice(0, 8) ?? [],
    signals: w ? signalsFrom(target, w.names, w.types, w.total) : [],
    actionable: false,
  };

  // Ownership: which installed app does this path belong to?
  const apps = await installedApps();
  const segments = target.split("/").filter(Boolean);
  for (const seg of segments.reverse()) {
    const owner = ownerOf(seg, apps);
    if (owner) {
      const proc = path.basename(owner.path, ".app");
      result.owner = { app: owner.name, appPath: owner.path, running: await platform.isProcessRunning(proc) };
      break;
    }
  }
  if (!result.owner && /Library\/(Application Support|Containers|Caches)\//.test(target)) {
    result.signals.push("No installed app matches this folder: possibly left behind by an uninstalled app, or used by a command-line tool.");
  }

  // Would a built-in rule claim it?
  for (const rule of loadRules()) {
    for (const pattern of rule.paths) {
      const matches = await expandPattern(pattern);
      if (matches.some((m) => isWithin(target, m))) {
        result.matchingRule = { id: rule.id, name: rule.name, tier: rule.tier };
        break;
      }
    }
    if (result.matchingRule) break;
  }

  const note = noteFor(target);
  if (note) {
    result.note = note.path === target ? note.note : `${tildify(note.path)}: ${note.note}`;
    result.decision = note.decision;
  }
  const cleaned = lastCleaned(target);
  if (cleaned) result.grewBack = { cleanedAt: cleaned.at, sizeThen: cleaned.size };
  if (!isDir) result.downloadedFrom = await whereFrom(target);

  const verdict = await assertSafe(target);
  result.actionable = verdict.ok;
  if (!verdict.ok) result.protectedReason = verdict.reason;
  return result;
}

export function formatInspect(r: InspectResult): string {
  if (r.kind === "missing") return `${tildify(r.path)} does not exist.`;
  const L: string[] = [];
  L.push(`${tildify(r.path)} — ${r.kind}, ${formatBytes(r.size)}${r.complete ? "" : " (walk cut short: at least this much)"}`);
  if (r.kind === "folder") L.push(`${r.files.toLocaleString()} files in ${r.folders.toLocaleString()} folders; last activity ${describeAge(r.lastActivity)}`);
  else L.push(`last modified ${describeAge(r.lastActivity)}`);
  if (r.owner) L.push(`Owner: ${r.owner.app} (${r.owner.appPath})${r.owner.running ? " — currently running" : ""}`);
  if (r.matchingRule) L.push(`Known item: "${r.matchingRule.name}" (rule ${r.matchingRule.id}, tier ${r.matchingRule.tier})`);
  if (r.note) L.push(`Your notes: ${r.note}${r.decision ? ` [decision: ${r.decision}]` : ""}`);
  if (r.grewBack) L.push(`Cleaned before on ${new Date(r.grewBack.cleanedAt).toDateString()} (${formatBytes(r.grewBack.sizeThen)}); it has grown back to ${formatBytes(r.size)}.`);
  if (r.downloadedFrom) L.push(`Downloaded from: ${r.downloadedFrom.join(", ")}`);
  if (r.signals.length) L.push("Signals:", ...r.signals.map((s) => `  - ${s}`));
  if (r.age.length) L.push("Age of contents (by last modification):", ...r.age.map((a) => `  ${a.label.padEnd(12)} ${formatBytes(a.bytes).padStart(9)}  (${a.files} files)`));
  if (r.types.length) L.push("Types:", ...r.types.map((t) => `  .${t.ext.padEnd(10)} ${formatBytes(t.bytes).padStart(9)}  (${t.files} files)`));
  if (r.children.length) L.push("Largest items inside:", ...r.children.map((c) => `  ${formatBytes(c.size).padStart(9)}  ${c.name}${c.isFile ? "" : "/"}  (${describeAge(c.lastActivity)})`));
  if (r.largestFiles.length) L.push("Largest files:", ...r.largestFiles.map((f) => `  ${formatBytes(f.size).padStart(9)}  ${tildify(f.path)}  (${describeAge(f.modified)})`));
  if (r.recentFiles.length) L.push("Most recently changed:", ...r.recentFiles.map((f) => `  ${describeAge(f.modified).padEnd(14)} ${tildify(f.path)}`));
  L.push(r.actionable ? "Can be proposed for cleanup: yes" : `Can be proposed for cleanup: no — ${r.protectedReason}`);
  return L.join("\n");
}
