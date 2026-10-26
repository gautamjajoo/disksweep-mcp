/**
 * Installed apps: discovery, ownership of ~/Library folders, and apps you
 * haven't opened in months. (Leftovers of uninstalled apps: leftovers.ts.)
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPlatform } from "../platform/index.js";
import { describeAge } from "../format.js";
import { userHome } from "../paths.js";
import { checkPath } from "../safety/guard.js";
import { Candidate, candidateId } from "./types.js";
import { processesFrom } from "./leftovers.js";
import { Sizer } from "./sizes.js";

const run = promisify(execFile);

export interface InstalledApp {
  path: string;
  name: string;
  bundleId?: string;
}

async function bundleId(app: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", path.join(app, "Contents/Info.plist")]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

let appsCache: { at: number; apps: InstalledApp[] } | undefined;

/** Apps in /Applications, ~/Applications and /System/Applications (one level + one subfolder). */
export async function installedApps(): Promise<InstalledApp[]> {
  if (appsCache && Date.now() - appsCache.at < 5 * 60_000) return appsCache.apps;
  const roots = process.env.DISKSWEEP_APP_DIRS
    ? process.env.DISKSWEEP_APP_DIRS.split(":") // tests
    : ["/Applications", path.join(userHome(), "Applications"), "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities"];
  const apps: InstalledApp[] = [];
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(root);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = path.join(root, n);
      if (n.endsWith(".app")) apps.push({ path: p, name: n.slice(0, -4), bundleId: await bundleId(p) });
      else if (!n.startsWith(".") && root === "/Applications") {
        // Vendor folders like /Applications/Adobe Photoshop 2025/
        try {
          for (const m of await fs.promises.readdir(p)) {
            if (m.endsWith(".app")) apps.push({ path: path.join(p, m), name: m.slice(0, -4), bundleId: await bundleId(path.join(p, m)) });
          }
        } catch {
          /* not a folder */
        }
      }
    }
  }
  appsCache = { at: Date.now(), apps };
  return apps;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Which installed app (if any) a ~/Library data folder name belongs to.
 * Matches bundle ids (com.foo.Bar), their prefixes and plain app names.
 */
export function ownerOf(folderName: string, apps: InstalledApp[]): InstalledApp | undefined {
  const f = folderName.toLowerCase();
  const fn = norm(folderName);
  for (const a of apps) {
    const id = a.bundleId?.toLowerCase();
    if (id && (f === id || f.startsWith(id + ".") || id.startsWith(f + ".") || f.endsWith("." + id) || f.includes(id))) return a;
    const an = norm(a.name);
    if (an.length >= 3 && (fn === an || fn.startsWith(an) || an.startsWith(fn))) return a;
  }
  return undefined;
}

export async function findUnusedApps(sizer: Sizer, unusedDays: number, minBytes: number): Promise<Candidate[]> {
  if (process.platform !== "darwin") return [];
  const platform = getPlatform();
  const out: Candidate[] = [];
  for (const app of await installedApps()) {
    if (path.dirname(app.path) !== "/Applications") continue;
    if (!checkPath(app.path).ok) continue;
    // Only Spotlight's real "last opened" counts; when macOS didn't record it, we don't guess.
    const used = await platform.lastUsed(app.path);
    if (!used || Date.now() - used.getTime() < unusedDays * 86_400_000) continue;
    // Running now (its processes may have other names, e.g. ChatGPT.app runs "Codex (Service)").
    if ((await processesFrom(path.basename(app.path, ".app"))).length) continue;
    const appSize = await sizer.sizeOf(app.path);
    if (appSize < minBytes) continue;
    if (await platform.isOsVendorApp(app.path)) continue;

    const extras = [
      path.join(userHome(), "Library/Application Support", app.name),
      app.bundleId && path.join(userHome(), "Library/Caches", app.bundleId),
      app.bundleId && path.join(userHome(), "Library/Containers", app.bundleId),
    ].filter((p): p is string => !!p && fs.existsSync(p) && checkPath(p).ok);
    let total = appSize;
    for (const e of extras) total += await sizer.sizeOf(e);

    out.push({
      id: candidateId("unused-app", [app.path, ...extras]),
      title: `Unused app: ${app.name}`,
      detector: "unused-app",
      category: "apps",
      tier: "review",
      paths: [app.path, ...extras],
      size: total,
      reason:
        `Last opened ${describeAge(used)}.` +
        (extras.length ? ` Includes ${extras.length} data folder(s) it keeps in ~/Library; its settings would be lost.` : ""),
      lastUsed: used.getTime(),
      app: app.name,
    });
  }
  return out;
}
