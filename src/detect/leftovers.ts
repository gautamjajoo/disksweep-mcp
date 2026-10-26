/**
 * Leftovers of uninstalled apps, however small: AppCleaner-style, but driven
 * by evidence the assistant can check. Apps leave data under their bundle id
 * (com.todesktop.230313mzl4w4u92 = Cursor), their name (~/.cursor,
 * cursor-updater) or both, scattered over a dozen places. We search only those
 * places (one level deep, never recursively), match whole words / bundle ids
 * (never substrings), and refuse to call anything a leftover while the app is
 * still installed anywhere.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describeAge, formatBytes } from "../format.js";
import { dataPath, isWithinFolded, readJson, tildify, userHome, writeJson } from "../paths.js";
import { checkPath } from "../safety/guard.js";
import { duTree } from "../scan/du.js";
import { TopFiles } from "../scan/tree.js";
import { installedApps, InstalledApp, ownerOf } from "./apps.js";
import { expandPattern } from "./rules.js";
import { Candidate, Tier, candidateId } from "./types.js";

const run = promisify(execFile);

interface Identity {
  app: string;
  ids: string[];
  names: string[];
  paths?: string[];
  /** Never treated as this app's leftovers (e.g. a CLI from the same vendor). */
  keep?: string[];
  /** Found from data on disk rather than the identity table: less certain. */
  inferred?: boolean;
}

interface Location {
  rel: string;
  kind: string;
  tier: Tier;
  /** Listed for completeness; the guard never lets disksweep remove these. */
  reportOnly?: boolean;
  /** Only names that look like installers count here. */
  installersOnly?: boolean;
}

const LOCATIONS: Location[] = [
  { rel: "", kind: "app data in your home folder", tier: "review" },
  { rel: "Library/Application Support", kind: "app data", tier: "review" },
  { rel: "Library/Application Support/Caches", kind: "updater cache", tier: "safe" },
  { rel: "Library/Application Support/CrashReporter", kind: "crash report info", tier: "safe" },
  { rel: "Library/Caches", kind: "cache", tier: "safe" },
  { rel: "Library/Containers", kind: "sandboxed app data", tier: "review" },
  { rel: "Library/Group Containers", kind: "shared app data", tier: "review" },
  { rel: "Library/Logs", kind: "logs", tier: "safe" },
  { rel: "Library/Saved Application State", kind: "saved window state", tier: "safe" },
  { rel: "Library/HTTPStorages", kind: "web cookies/cache", tier: "safe" },
  { rel: "Library/WebKit", kind: "web data", tier: "safe" },
  { rel: "Library/Preferences", kind: "settings", tier: "review", reportOnly: true },
  { rel: "Library/LaunchAgents", kind: "background launcher", tier: "review", reportOnly: true },
  { rel: "Library/Cookies", kind: "cookies", tier: "review", reportOnly: true },
  { rel: "Downloads", kind: "installer", tier: "rebuildable", installersOnly: true },
];

const INSTALLER_RE = /\.(dmg|pkg|zip|app)$/i;
/** Suffixes apps append to their bundle id for related items. */
const ID_SUFFIX_RE = /\.(shipit|savedstate|plist|binarycookies|helper|updater|crashpad)$/i;
/** Generic folder names that are never an app identity on their own. */
const GENERIC = new Set(
  ["caches", "crashreporter", "addressbook", "clouddocs", "icloud", "knowledge", "mobilesync", "google", "microsoft", "adobe",
   "jetbrains", "apple", "logs", "cache", "temp", "tmp", "data", "app", "code", "default", "com", "org", "net", "io", "dev",
   "diagnosticreports", "callhistorydb", "dock", "syncservices", "fileprovider", "accounts"].map((s) => s.toLowerCase()),
);

const RULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../rules");

export function loadIdentities(): Identity[] {
  try {
    return (JSON.parse(fs.readFileSync(path.join(RULES_DIR, "app-identities.json"), "utf8")) as { apps: Identity[] }).apps;
  } catch {
    return [];
  }
}

const lower = (s: string) => s.toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BUNDLE_ID_RE = /^[a-z0-9-]+(\.[a-z0-9_-]+){2,}$/i;

/** "wispr flow" -> matches "Wispr Flow", "wispr-flow", "wispr_flow", "wisprflow" as a whole word. */
function nameRegex(name: string): RegExp {
  const parts = name.toLowerCase().split(/\s+/).map(escapeRe);
  return new RegExp(`(^|[^a-z0-9])${parts.join("[ _-]?")}([^a-z0-9]|$)`);
}

/** Strip Group Container team prefixes ("UBF8T346G9.com.microsoft") and known suffixes. */
function baseId(entry: string): string {
  let e = entry.replace(/^[A-Z0-9]{10}\./, "");
  e = e.replace(/^group\./i, "");
  while (ID_SUFFIX_RE.test(e)) e = e.replace(ID_SUFFIX_RE, "");
  return e;
}

interface Match {
  why: string;
  certain: boolean;
}

function matchEntry(entry: string, id: Identity, loc: Location): Match | undefined {
  const name = lower(entry);
  const stripped = name.replace(/^\./, "");
  for (const bid of id.ids.map(lower)) {
    const b = lower(baseId(entry));
    if (b === bid || b.startsWith(bid + ".")) return { why: `named after ${id.app}'s bundle id ${bid}`, certain: true };
  }
  // Names only match plain folder names: "openai" must not claim com.openai.codex.
  if (BUNDLE_ID_RE.test(baseId(entry))) return undefined;
  for (const n of id.names) {
    if (n.length < 3 || GENERIC.has(lower(n))) continue;
    if (loc.rel === "" && !name.startsWith(".")) continue; // only dot-folders directly in home
    if (loc.installersOnly && !INSTALLER_RE.test(name)) continue;
    if (nameRegex(n).test(stripped)) return { why: `named after "${n}"`, certain: !id.inferred };
  }
  return undefined;
}

export interface LeftoverItem {
  path: string;
  /** Matched by bundle id or a known location: strong evidence it belongs to the app (not a shared folder). */
  strong: boolean;
  size: number;
  newest?: number;
  kind: string;
  tier: Tier;
  why: string;
  certain: boolean;
  actionable: boolean;
  blockedReason?: string;
  /** For folders: a few names inside, so the assistant can judge (e.g. "skills/"). */
  contains?: string[];
}

async function measure(p: string): Promise<{ size: number; newest?: number }> {
  const res = await duTree([p], { minNodeBytes: Number.MAX_SAFE_INTEGER, topFiles: new TopFiles(0, Infinity) });
  const st = await fs.promises.lstat(p).catch(() => undefined);
  return { size: res.roots[0]?.size ?? 0, newest: res.roots[0]?.mtime ?? st?.mtimeMs };
}

async function peek(p: string): Promise<string[] | undefined> {
  try {
    const entries = await fs.promises.readdir(p, { withFileTypes: true });
    return entries.slice(0, 8).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  } catch {
    return undefined;
  }
}

async function searchFor(id: Identity): Promise<LeftoverItem[]> {
  const home = userHome();
  const found = new Map<string, LeftoverItem>();
  const add = async (p: string, loc: Location | undefined, m: Match) => {
    if (found.has(p)) return;
    const g = checkPath(p);
    const { size, newest } = await measure(p);
    const st = await fs.promises.lstat(p).catch(() => undefined);
    found.set(p, {
      path: p,
      strong: !id.inferred && (m.why.includes("bundle id") || m.why.includes("known")),
      size,
      newest,
      kind: loc?.kind ?? "app data",
      tier: loc?.tier ?? "review",
      why: m.why,
      certain: m.certain,
      actionable: g.ok && !loc?.reportOnly,
      blockedReason: !g.ok ? g.reason : loc?.reportOnly ? "settings/launch items are kept by disksweep's safety rules" : undefined,
      contains: st?.isDirectory() && !p.endsWith(".app") ? await peek(p) : undefined,
    });
  };

  for (const loc of LOCATIONS) {
    const dir = path.join(home, loc.rel);
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of names) {
      if (lower(entry).startsWith("com.apple.")) continue;
      const m = matchEntry(entry, id, loc);
      if (m) await add(path.join(dir, entry), loc, m);
    }
  }
  const keep = (id.keep ?? []).map((k) => k.replace(/^~/, home));
  for (const pattern of id.paths ?? []) {
    for (const p of await expandPattern(pattern)) {
      const loc = [...LOCATIONS].reverse().find((l) => p.startsWith(path.join(home, l.rel) + "/"));
      await add(p, loc, { why: `a known ${id.app} location`, certain: true });
    }
  }
  // Drop protected paths and items nested inside another found item.
  const items = [...found.values()].filter((it) => !keep.some((k) => isWithinFolded(it.path, k)));
  return items
    .filter((it) => !items.some((o) => o !== it && it.path.startsWith(o.path + "/")))
    .sort((a, b) => b.size - a.size);
}

export interface ProcessFromApp {
  pid: number;
  command: string;
  bundle: string;
  bundleExists: boolean;
}

/** Processes running from "<App>.app/Contents/…", and whether that bundle still exists on disk. */
export async function processesFrom(appName: string): Promise<ProcessFromApp[]> {
  if (BUNDLE_ID_RE.test(appName)) return [];
  try {
    const { stdout } = await run("/usr/bin/pgrep", ["-lf", `/${escapeRe(appName)}\\.app/Contents/`]);
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const sp = line.indexOf(" ");
        const command = line.slice(sp + 1);
        const bundle = command.slice(0, command.indexOf("/Contents/"));
        return { pid: Number(line.slice(0, sp)), command, bundle, bundleExists: fs.existsSync(bundle) };
      });
  } catch {
    return [];
  }
}

/** Is the app still installed anywhere (Spotlight knows about bundles outside /Applications too)? */
async function installedLocation(id: Identity, apps: InstalledApp[]): Promise<string | undefined> {
  // Running from a bundle that still exists = installed somewhere we didn't look.
  const live = (await processesFrom(id.app)).find((p) => p.bundleExists);
  if (live) return `${live.bundle} (running)`;
  // Names guessed from folders ("Bitcoin") must not miss a similarly named app ("Bitcoin-Qt").
  if (id.inferred) {
    for (const n of [id.app, ...id.names]) {
      const owner = ownerOf(n, apps);
      if (owner) return owner.path;
    }
  }
  const names = [id.app, ...id.names].map(lower);
  const ids = id.ids.map(lower);
  const local = apps.find((a) => names.includes(lower(a.name)) || (a.bundleId && ids.includes(lower(a.bundleId))));
  if (local) return local.path;
  for (const bid of id.ids) {
    try {
      const { stdout } = await run("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == "${bid.replace(/"/g, "")}"`]);
      const hit = stdout
        .split("\n")
        .find((p) => p.endsWith(".app") && !p.includes("/.Trash/") && !p.includes("/Caches/") && !p.includes(".ShipIt/"));
      if (hit) return hit;
    } catch {
      /* Spotlight unavailable */
    }
  }
  return undefined;
}

/** Turn a user-typed app name into an identity: table entry, or inferred from data on disk. */
async function resolveIdentity(appName: string): Promise<Identity> {
  const q = lower(appName.trim().replace(/\.app$/i, ""));
  const known = loadIdentities().find(
    (i) => lower(i.app) === q || i.names.map(lower).includes(q) || i.ids.map(lower).includes(q),
  );
  if (known) return known;
  // Unknown app: look for bundle ids on disk that contain the name as a component prefix.
  const ids = new Set<string>();
  if (q.replace(/\s+/g, "").length < 4) return { app: appName.trim(), ids: [], names: [q], inferred: true };
  const installedVendors = new Set(
    (await installedApps()).map((a) => a.bundleId && lower(a.bundleId).split(".").slice(0, 2).join(".")).filter(Boolean),
  );
  const home = userHome();
  for (const rel of ["Library/Containers", "Library/Caches", "Library/Preferences", "Library/Application Support", "Library/Saved Application State", "Library/HTTPStorages"]) {
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(path.join(home, rel));
    } catch {
      continue;
    }
    for (const n of names) {
      const b = baseId(n);
      if (!BUNDLE_ID_RE.test(b) || lower(b).startsWith("com.apple.")) continue;
      const comps = lower(b).split(".").slice(1);
      // Skip ids from a vendor with an installed app: likely that app's helper.
      if (installedVendors.has(lower(b).split(".").slice(0, 2).join("."))) continue;
      if (comps.some((c) => c.startsWith(q.replace(/\s+/g, "")))) ids.add(b);
    }
  }
  return { app: appName.trim(), ids: [...ids], names: [q], inferred: true };
}

export interface LeftoverReport {
  app: string;
  /**
   * leftover        - app gone, its data untouched for a while
   * installed       - app is installed or running: live data
   * recently-active - no installed copy found, but its data changed recently
   *                   (being updated, moved, bundled inside another app…): not leftovers
   */
  status: "leftover" | "installed" | "recently-active";
  installedAt?: string;
  items: LeftoverItem[];
  candidates: Candidate[];
  inferred: boolean;
  /** Processes still running from the deleted app bundle. */
  staleProcesses?: ProcessFromApp[];
  /** An installed app from the same vendor (com.google.* while Chrome is installed): may be a shared helper. */
  sameVendorAs?: string;
}

const ACTIVE_DAYS = 30;
export const isActive = (it: LeftoverItem) => !!it.newest && Date.now() - it.newest < ACTIVE_DAYS * 86_400_000;

/**
 * Judge the app by its own data (bundle-id matches) when there is any: a
 * shared folder like ~/.cursor/skills being active says nothing about Cursor.
 */
function appRecentlyActive(items: LeftoverItem[]): boolean {
  const own = items.some((it) => it.strong) ? items.filter((it) => it.strong) : items;
  return own.some(isActive);
}

/**
 * explicit: the user named the app as removed. Then the app's own data may
 * have changed recently (they used it until deleting it); only shared,
 * name-matched folders that are still being written stay out.
 */
function toCandidates(app: string, items: LeftoverItem[], explicit = false): Candidate[] {
  return items
    .filter((it) => it.actionable && (!isActive(it) || (explicit && it.strong)))
    .map((it) => ({
      id: candidateId(`leftover:${app}`, [it.path]),
      title: `${app} leftover: ${tildify(it.path)}`,
      detector: "app-leftover" as const,
      category: "apps",
      tier: it.certain ? it.tier : "review",
      paths: [it.path],
      size: it.size,
      reason: `${it.kind} left by ${app}, which is not installed (${it.why}).`,
      lastUsed: it.newest,
      leftoverOf: app,
      foundAt: Date.now(),
    }));
}

export async function leftoversFor(appName: string): Promise<LeftoverReport> {
  const id = await resolveIdentity(appName);
  const installedAt = await installedLocation(id, await installedApps());
  const items = await searchFor(id);
  // The user told us the app is gone: recent activity is expected, not a reason to hold back.
  const status = installedAt ? "installed" : "leftover";
  const candidates = status === "leftover" ? toCandidates(id.app, items, true) : [];
  registerCandidates(candidates);
  const staleProcesses = installedAt ? undefined : (await processesFrom(id.app)).filter((p) => !p.bundleExists);
  return { app: id.app, status, installedAt, items, candidates, inferred: !!id.inferred, staleProcesses };
}

/**
 * Every app that left data behind but is no longer installed, grouped per app.
 * Used by app_leftovers without an app name, and by analyse.
 */
export async function discoverUninstalled(): Promise<LeftoverReport[]> {
  const apps = await installedApps();
  const table = loadIdentities();
  const groups = new Map<string, Identity>();
  const home = userHome();

  for (const loc of LOCATIONS.filter((l) => l.rel.startsWith("Library/") && !l.reportOnly)) {
    let names: string[];
    try {
      names = await fs.promises.readdir(path.join(home, loc.rel));
    } catch {
      continue;
    }
    for (const entry of names) {
      if (entry.startsWith(".") || lower(entry).startsWith("com.apple.") || lower(entry).includes(".com.apple.")) continue;
      const known = table.find((i) => matchEntry(entry, i, loc));
      if (known) {
        groups.set(known.app, known);
        continue;
      }
      const b = baseId(entry);
      if (BUNDLE_ID_RE.test(b)) {
        if (!groups.has(b)) groups.set(b, { app: b, ids: [b], names: [], inferred: true });
      } else if (loc.rel === "Library/Application Support" && !GENERIC.has(lower(entry)) && entry.length >= 3) {
        if (!groups.has(entry)) groups.set(entry, { app: entry, ids: [], names: [lower(entry)], inferred: true });
      }
    }
  }

  // Strongest identities first, so each item belongs to exactly one app:
  // identity table, then bundle ids, then plain folder names.
  const rank = (i: Identity) => (!i.inferred ? 0 : i.ids.length ? 1 : 2);
  const ordered = [...groups.values()].sort((a, b) => rank(a) - rank(b));
  const claimed = new Set<string>();
  const reports: LeftoverReport[] = [];
  for (const id of ordered) {
    if (await installedLocation(id, apps)) continue;
    // Bundle-id groups may belong to an installed app under a vendor id (com.adobe.*).
    if (id.inferred && apps.some((a) => a.bundleId && id.ids.some((x) => lower(x).startsWith(lower(a.bundleId!)) || lower(a.bundleId!).startsWith(lower(x) + ".")))) continue;
    const items = (await searchFor(id)).filter((it) => !claimed.has(it.path));
    if (!items.length) continue;
    items.forEach((it) => claimed.add(it.path));
    const status = appRecentlyActive(items) ? "recently-active" : "leftover";
    const vendor = (x: string) => lower(x).split(".").slice(0, 2).join(".");
    const sibling = id.inferred
      ? apps.find((a) => a.bundleId && id.ids.some((x) => vendor(x) === vendor(a.bundleId!) && vendor(x).includes(".")))
      : undefined;
    if (sibling) items.forEach((it) => (it.certain = false));
    reports.push({
      app: id.app, status, items, candidates: status === "leftover" ? toCandidates(id.app, items) : [],
      inferred: !!id.inferred, sameVendorAs: sibling?.name,
    });
  }
  const all = reports.flatMap((r) => r.candidates);
  registerCandidates(all);
  const total = (r: LeftoverReport) => r.items.reduce((s, i) => s + i.size, 0);
  return reports.sort((a, b) => total(b) - total(a));
}

/** Leftover candidates live outside the analysis so create_proposal can find them. */
export function registerCandidates(list: Candidate[]): void {
  if (!list.length) return;
  const file = dataPath("extra-candidates.json");
  const existing = readJson<Candidate[]>(file, []).filter((c) => !list.some((n) => n.id === c.id));
  writeJson(file, [...list, ...existing].slice(0, 500));
}

const CANDIDATE_TTL_MS = 24 * 3600_000;

export function extraCandidates(): Candidate[] {
  return readJson<Candidate[]>(dataPath("extra-candidates.json"), []).filter(
    (c) => c.foundAt && Date.now() - c.foundAt < CANDIDATE_TTL_MS,
  );
}

/** Is the app installed (or running from an existing bundle) right now? */
export async function appPresent(appName: string): Promise<boolean> {
  const id = await resolveIdentity(appName);
  return !!(await installedLocation(id, await installedApps()));
}

export function formatLeftovers(r: LeftoverReport, detailed = true): string {
  const total = r.items.reduce((s, i) => s + i.size, 0);
  const L: string[] = [];
  if (r.status === "installed") {
    L.push(`${r.app} is installed (${r.installedAt}), so these are its live data, not leftovers. Uninstall it first if you want them gone.`);
  } else if (r.status === "recently-active") {
    const newest = Math.max(...r.items.map((i) => i.newest ?? 0));
    L.push(
      `${r.app}: no installed copy found, but its data changed ${describeAge(newest)}. Either you removed it recently, or it's being updated, moved, or bundled inside another app. Not suggested automatically; if you removed it, call app_leftovers "${r.app}". ${r.items.length} item(s), ${formatBytes(total)}:`,
    );
  } else {
    L.push(`${r.app}${r.inferred ? " (identified from data on disk, not the built-in app list: check the matches)" : ""} is not installed. ${r.items.length} item(s), ${formatBytes(total)}:`);
    if (r.sameVendorAs) L.push(`  Caution: same vendor as the installed app ${r.sameVendorAs}; this may be a helper it still relies on.`);
    for (const p of r.staleProcesses ?? []) {
      const exe = path.basename(p.command.slice(0, p.command.indexOf(" ") > 0 ? p.command.indexOf(" ") : undefined));
      L.push(`  Note: process ${p.pid} (${exe}) is still running from the deleted ${p.bundle}. It holds no data here, but quit it (or restart) to fully remove the app.`);
    }
  }
  if (!r.items.length) L.push("  Nothing found.");
  for (const it of r.items) {
    const cand = r.candidates.find((c) => c.paths[0] === it.path);
    const tag = cand ? `[${cand.id}] ` : "";
    L.push(`- ${tag}${formatBytes(it.size).padStart(8)}  ${tildify(it.path)}`);
    if (!detailed) continue;
    L.push(`    ${it.kind}; ${it.why}${it.certain ? "" : " (uncertain match)"}; last changed ${describeAge(it.newest)}`);
    if (it.contains?.length) L.push(`    contains: ${it.contains.join(", ")}`);
    if (r.status === "leftover" && isActive(it)) {
      L.push(
        it.strong
          ? `    changed ${describeAge(it.newest)} (expected if you used ${r.app} until recently)`
          : `    ⚠ changed in the last ${ACTIVE_DAYS} days and only matched by name: something else may share it. Inspect before removing.`,
      );
    }
    if (!it.actionable) L.push(`    not removable by disksweep: ${it.blockedReason}`);
  }
  return L.join("\n");
}
