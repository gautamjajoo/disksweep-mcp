import { loadConfig } from "./config.js";
import { formatBytes, describeAge } from "./format.js";
import { isWithin, isWithinFolded, tildify, expandHome, dataPath, writeJson, readJson } from "./paths.js";
import { checkPath } from "./safety/guard.js";
import { ScanIndex } from "./scan/tree.js";
import { growthOver, Growth } from "./scan/snapshot.js";
import { Sizer } from "./detect/sizes.js";
import { loadRules, runRules } from "./detect/rules.js";
import { findProjectArtifacts } from "./detect/projects.js";
import { findLargeFiles, findStaleDownloads } from "./detect/files.js";
import { findUnusedApps } from "./detect/apps.js";
import { discoverUninstalled, isActive } from "./detect/leftovers.js";
import { findDuplicates } from "./detect/duplicates.js";
import { Advisory, Candidate, Tier, candidateId } from "./detect/types.js";
import { isExcluded, lastCleaned, loadHistory, loadNotes, noteFor } from "./memory.js";

export type DetectorName = "rules" | "projects" | "large-files" | "downloads" | "apps" | "leftovers" | "duplicates";
export const ALL_DETECTORS: DetectorName[] = ["rules", "projects", "large-files", "downloads", "apps", "leftovers", "duplicates"];
const DEFAULT_DETECTORS: DetectorName[] = ["rules", "projects", "large-files", "downloads", "apps", "leftovers"];

export interface AnalysedCandidate extends Candidate {
  note?: string;
  grewBack?: { cleanedAt: number; sizeThen: number };
}

export interface Analysis {
  at: number;
  candidates: AnalysedCandidate[];
  advisories: Advisory[];
  growth: { days: number; since?: string; items: Growth[] }[];
  /** Big folders in the index that nothing explains: for the assistant to investigate. */
  unexplained: { path: string; size: number; loose: number; lastActivity?: number }[];
  excluded: number;
}

const MB = 1000 * 1000;

export async function analyse(index: ScanIndex | undefined, detectors: DetectorName[] = DEFAULT_DETECTORS): Promise<Analysis> {
  const cfg = loadConfig();
  const sizer = new Sizer(index);
  const claimed: string[] = [];
  let candidates: Candidate[] = [];
  const advisories: Advisory[] = [];
  const on = (d: DetectorName) => detectors.includes(d);

  if (on("projects") && index) {
    const found = await findProjectArtifacts(index, cfg.staleProjectDays, 50 * MB);
    candidates.push(...found);
    claimed.push(...found.flatMap((c) => c.paths));
  }
  if (on("rules")) {
    const r = await runRules(loadRules(), sizer, claimed);
    candidates.push(...r.candidates);
    advisories.push(...r.advisories);
  }
  if (on("apps")) {
    const found = await findUnusedApps(sizer, cfg.unusedAppDays, 100 * MB);
    candidates.push(...found);
    claimed.push(...found.flatMap((c) => c.paths));
  }
  if (on("leftovers")) {
    // One suggestion per uninstalled app, covering everything it left (even tiny
    // files) except items something still writes to.
    for (const r of await discoverUninstalled()) {
      const items = r.items.filter((it) => it.actionable && !isActive(it) && !claimed.some((c) => isWithin(it.path, c) || isWithin(c, it.path)));
      const total = items.reduce((s, it) => s + it.size, 0);
      if (!items.length || total < 10 * MB) continue;
      const vendorNote = r.sameVendorAs ? ` Same vendor as the installed ${r.sameVendorAs}: may be a helper it still uses.` : "";
      const paths = items.map((it) => it.path);
      candidates.push({
        id: candidateId(`leftovers:${r.app}`, paths),
        title: `Leftovers of uninstalled app: ${r.app} (${items.length} item${items.length > 1 ? "s" : ""})`,
        detector: "app-leftover",
        category: "apps",
        tier: items.every((it) => it.tier === "safe" && it.certain) ? "safe" : "review",
        paths,
        size: total,
        reason: `${r.app} is no longer installed${r.inferred ? " (identified from its data, not the built-in app list)" : ""}.${vendorNote} Use app_leftovers "${r.app}" to see each item and why it matched.`,
        lastUsed: Math.max(...items.map((it) => it.newest ?? 0)) || undefined,
        leftoverOf: r.app,
      });
      claimed.push(...paths);
    }
  }
  if (on("downloads")) {
    const found = await findStaleDownloads(sizer, claimed, cfg.staleDownloadDays, 50 * MB);
    candidates.push(...found);
    claimed.push(...found.flatMap((c) => c.paths));
  }
  if (on("large-files") && index) {
    const found = await findLargeFiles(index, claimed, 1000 * MB);
    candidates.push(...found);
    claimed.push(...found.flatMap((c) => c.paths));
  }
  if (on("duplicates")) {
    const found = (await findDuplicates()).filter((c) => !c.paths.some((p) => claimed.some((x) => isWithin(p, x))));
    candidates.push(...found);
  }

  // Safety + user decisions: drop anything the guard would refuse or the user excluded.
  const notes = loadNotes();
  const protectedByUser = cfg.protected.map(expandHome);
  let excluded = 0;
  candidates = candidates.filter((c) => {
    const ok =
      c.paths.every((p) => checkPath(p).ok) &&
      !c.paths.some((p) => isExcluded(p, notes)) &&
      !c.paths.some((p) => protectedByUser.some((x) => isWithinFolded(p, x) || isWithinFolded(x, p)));
    if (!ok) excluded++;
    return ok;
  });

  const history = loadHistory();
  const analysed: AnalysedCandidate[] = candidates.map((c) => {
    const a: AnalysedCandidate = { ...c };
    const n = noteFor(c.paths[0], notes);
    if (n?.note) a.note = n.note;
    const cleaned = lastCleaned(c.paths[0], history);
    if (cleaned) a.grewBack = { cleanedAt: cleaned.at, sizeThen: cleaned.size };
    return a;
  });
  analysed.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || b.size - a.size);

  const result: Analysis = {
    at: Date.now(),
    candidates: analysed,
    advisories,
    growth: [1, 7, 30].map((days) => ({ days, ...growthOver(days, 8) })),
    unexplained: index ? unexplainedFolders(index, [...claimed, ...analysed.flatMap((c) => c.paths)], notes) : [],
    excluded,
  };
  writeJson(dataPath("last-analysis.json"), result);
  return result;
}

export function lastAnalysis(): Analysis | undefined {
  return readJson<Analysis | undefined>(dataPath("last-analysis.json"), undefined);
}

const tierRank = (t: Tier) => ({ safe: 0, rebuildable: 1, review: 2 })[t];

/**
 * The deepest large folders in your home that no detector, rule or note
 * accounts for. These are exactly what the assistant should `inspect`.
 */
function unexplainedFolders(index: ScanIndex, explained: string[], notes: ReturnType<typeof loadNotes>, minBytes = 500 * MB) {
  const home = expandHome("~");
  const out: { path: string; size: number; loose: number; lastActivity?: number }[] = [];
  const visit = (node: ScanIndex["tree"]) => {
    if (node.isFile || node.size < minBytes) return;
    if (explained.some((e) => isWithin(node.path, e))) return; // already accounted for
    const bigKids = (node.children ?? []).filter((c) => !c.isFile && c.size >= minBytes);
    const kidsExplain = bigKids.reduce((s, c) => s + c.size, 0);
    // Report a folder when its big children don't account for most of it.
    if (isWithin(node.path, home) && node.path !== home && kidsExplain < node.size * 0.6) {
      const covered = explained.filter((e) => isWithin(e, node.path)).length > 0;
      if (!covered && !noteFor(node.path, notes) && checkPath(node.path).ok) {
        out.push({ path: node.path, size: node.size, loose: node.size - kidsExplain, lastActivity: node.mtime });
      }
    }
    for (const c of bigKids) visit(c);
  };
  visit(index.tree);
  return out.sort((a, b) => b.loose - a.loose).slice(0, 12);
}

export function formatAnalysis(a: Analysis, opts: { limit?: number } = {}): string {
  const limit = opts.limit ?? 12;
  const L: string[] = [];
  const total = (t: Tier) => a.candidates.filter((c) => c.tier === t).reduce((s, c) => s + c.size, 0);
  L.push(
    `Reclaimable: ${formatBytes(total("safe"))} safe · ${formatBytes(total("rebuildable"))} rebuildable · ${formatBytes(total("review"))} needs your review`,
  );
  if (a.excluded) L.push(`(${a.excluded} item(s) hidden by your decisions or protected paths)`);

  for (const tier of ["safe", "rebuildable", "review"] as Tier[]) {
    const items = a.candidates.filter((c) => c.tier === tier);
    if (!items.length) continue;
    L.push("", `## ${tier === "safe" ? "Safe — regenerates by itself" : tier === "rebuildable" ? "Rebuildable — can be recreated" : "Review — may contain your stuff"}`);
    for (const c of items.slice(0, limit)) {
      L.push(`- [${c.id}] ${formatBytes(c.size).padStart(8)}  ${c.title}`);
      L.push(`    ${c.paths.length === 1 ? tildify(c.paths[0]) : `${c.paths.length} paths, e.g. ${tildify(c.paths[0])}`}`);
      L.push(`    Why: ${c.reason}${c.regenerates ? ` Comes back: ${c.regenerates}` : ""}`);
      if (c.app) L.push(`    (Skipped automatically while ${c.app} is running.)`);
      if (c.note) L.push(`    Your note: ${c.note}`);
      if (c.grewBack) L.push(`    ⟲ Cleaned ${describeAge(c.grewBack.cleanedAt)} (${formatBytes(c.grewBack.sizeThen)}) and grew back — cleaning is temporary here; consider the app's own settings.`);
    }
    if (items.length > limit) {
      const more = items.slice(limit);
      L.push(`  …and ${more.length} more (${formatBytes(more.reduce((s, c) => s + c.size, 0))}); call analyse with a higher limit to list them`);
    }
  }
  if (a.advisories.length) {
    L.push("", "## Worth knowing (not cleaned by disksweep)");
    for (const ad of a.advisories) L.push(`- ${formatBytes(ad.size).padStart(8)}  ${ad.title}${ad.path ? ` (${tildify(ad.path)})` : ""}: ${ad.advice}`);
  }
  const grew = a.growth.find((g) => g.items.length);
  if (grew) {
    L.push("", `## Growing fastest (since ${grew.since})`);
    for (const g of grew.items.slice(0, 8)) L.push(`- +${formatBytes(g.delta).padStart(8)}  ${tildify(g.path)}  (now ${formatBytes(g.after)})`);
  }
  if (a.unexplained.length) {
    L.push("", "## Large and unexplained — inspect these to find out what they are");
    for (const u of a.unexplained) {
      const loose = u.loose < u.size * 0.95 ? `, ${formatBytes(u.loose)} of it outside its big subfolders` : "";
      L.push(`- ${formatBytes(u.size).padStart(8)}  ${tildify(u.path)}  (last activity ${describeAge(u.lastActivity)}${loose})`);
    }
  }
  return L.join("\n");
}
