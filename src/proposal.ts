/**
 * Proposals freeze exactly what the user is being asked to approve. The only
 * destructive tool acts on (proposal id, item number) pairs — never on raw
 * paths — and re-verifies every path at the moment of acting.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataPath, readJson, tildify, writeJson, expandHome, isWithin } from "./paths.js";
import { checkPath, assertSafe } from "./safety/guard.js";
import { getPlatform } from "./platform/index.js";
import { formatBytes } from "./format.js";
import { loadConfig } from "./config.js";
import { Sizer } from "./detect/sizes.js";
import { Tier } from "./detect/types.js";
import { AnalysedCandidate, lastAnalysis } from "./analyse.js";
import { extraCandidates } from "./detect/leftovers.js";
import { HistoryEntry, isExcluded, recordHistory } from "./memory.js";
import { loadIndex } from "./scan/scanner.js";

const TTL_MS = 24 * 3600_000;

export interface FrozenPath {
  path: string;
  size: number;
  ino: number;
  mtimeMs: number;
}

export interface ProposalItem {
  n: number;
  title: string;
  tier: Tier;
  reason: string;
  source: "detector" | "assistant";
  candidateId?: string;
  app?: string;
  paths: FrozenPath[];
  size: number;
  status: "pending" | "trashed" | "skipped" | "partial";
  outcome?: string;
}

export interface Proposal {
  id: string;
  createdAt: number;
  items: ProposalItem[];
}

const file = (id: string) => dataPath("proposals", `${id}.json`);

export function loadProposal(id: string): Proposal | undefined {
  if (!/^p[0-9a-f]{8}$/.test(id)) return undefined;
  return readJson<Proposal | undefined>(file(id), undefined);
}

async function freeze(p: string, sizer: Sizer): Promise<FrozenPath> {
  const st = await fs.promises.lstat(p);
  return { path: p, size: await sizer.sizeOf(p), ino: st.ino, mtimeMs: st.mtimeMs };
}

export interface CustomItem {
  path: string;
  reason: string;
  title?: string;
}

/**
 * Build a proposal from analysis candidates and/or items the assistant found by
 * investigating. Assistant items are always tier "review" and guard-checked.
 */
export async function createProposal(candidateIds: string[], custom: CustomItem[]): Promise<{ proposal: Proposal; rejected: string[] }> {
  const analysis = lastAnalysis();
  const sizer = new Sizer(loadIndex());
  const rejected: string[] = [];
  const items: ProposalItem[] = [];
  const protectedByUser = loadConfig().protected.map(expandHome);
  const userBlocked = (p: string) => protectedByUser.some((x) => isWithin(p, x) || isWithin(x, p)) || !!isExcluded(p);

  for (const id of candidateIds) {
    const c: AnalysedCandidate | undefined =
      analysis?.candidates.find((x) => x.id === id) ?? extraCandidates().find((x) => x.id === id);
    if (!c) {
      rejected.push(`${id}: unknown candidate id (run analyse or app_leftovers first)`);
      continue;
    }
    const paths: FrozenPath[] = [];
    for (const p of c.paths) {
      const g = checkPath(p);
      if (!g.ok) rejected.push(`${tildify(p)}: ${g.reason}`);
      else if (userBlocked(p)) rejected.push(`${tildify(p)}: you asked to keep this`);
      else if (fs.existsSync(p)) paths.push(await freeze(p, sizer));
    }
    if (!paths.length) continue;
    items.push({
      n: items.length + 1, title: c.title, tier: c.tier, reason: c.reason, source: "detector", candidateId: c.id,
      app: c.app, paths, size: paths.reduce((s, x) => s + x.size, 0), status: "pending",
    });
  }

  for (const ci of custom) {
    const p = expandHome(ci.path);
    if (p !== ci.path && !ci.path.startsWith("~")) {
      rejected.push(`${ci.path}: use an absolute path`);
      continue;
    }
    const g = checkPath(p);
    if (!g.ok) {
      rejected.push(`${ci.path}: ${g.reason}`);
      continue;
    }
    if (userBlocked(p)) {
      rejected.push(`${ci.path}: you asked to keep this`);
      continue;
    }
    if (!ci.reason?.trim()) {
      rejected.push(`${ci.path}: a reason is required for items you propose`);
      continue;
    }
    if (!fs.existsSync(p)) {
      rejected.push(`${ci.path}: does not exist`);
      continue;
    }
    const fp = await freeze(p, sizer);
    items.push({
      n: items.length + 1, title: ci.title ?? path.basename(p), tier: "review", reason: ci.reason, source: "assistant",
      paths: [fp], size: fp.size, status: "pending",
    });
  }

  // Never let two items overlap (would double count and double act).
  const seen: string[] = [];
  const unique = items.filter((it) => {
    const clash = it.paths.some((fp) => seen.some((s) => isWithin(fp.path, s) || isWithin(s, fp.path)));
    if (clash) rejected.push(`${it.title}: overlaps another item in this proposal`);
    else seen.push(...it.paths.map((fp) => fp.path));
    return !clash;
  });
  unique.forEach((it, i) => (it.n = i + 1));

  const proposal: Proposal = { id: `p${crypto.randomBytes(4).toString("hex")}`, createdAt: Date.now(), items: unique };
  writeJson(file(proposal.id), proposal);
  return { proposal, rejected };
}

export function formatProposal(p: Proposal): string {
  const L = [`Proposal ${p.id} — ${p.items.length} item(s), ${formatBytes(p.items.reduce((s, i) => s + i.size, 0))} total. Approved items go to the Trash (restorable with Put Back).`];
  for (const it of p.items) {
    L.push(`${String(it.n).padStart(2)}. ${formatBytes(it.size).padStart(8)}  [${it.tier}] ${it.title}${it.source === "assistant" ? " (found by investigation)" : ""}`);
    L.push(`      ${it.paths.length === 1 ? tildify(it.paths[0].path) : `${it.paths.length} paths: ${it.paths.slice(0, 3).map((x) => tildify(x.path)).join(", ")}${it.paths.length > 3 ? ", …" : ""}`}`);
    L.push(`      ${it.reason}`);
    if (it.status !== "pending") L.push(`      → ${it.status}${it.outcome ? `: ${it.outcome}` : ""}`);
  }
  return L.join("\n");
}

export interface TrashOutcome {
  proposal: Proposal;
  freed: number;
  results: { n: number; status: ProposalItem["status"]; detail: string }[];
}

/** Move approved items to the Trash after re-verifying each path. */
export async function trashApproved(proposalId: string, itemNumbers: number[]): Promise<TrashOutcome> {
  const proposal = loadProposal(proposalId);
  if (!proposal) throw new Error(`Unknown proposal ${proposalId}. Create a proposal and show it to the user first.`);
  if (Date.now() - proposal.createdAt > TTL_MS) throw new Error(`Proposal ${proposalId} is older than 24 hours. Analyse again and create a fresh proposal.`);
  const platform = getPlatform();
  const results: TrashOutcome["results"] = [];
  const history: HistoryEntry[] = [];
  let freed = 0;

  for (const n of [...new Set(itemNumbers)]) {
    const item = proposal.items.find((i) => i.n === n);
    if (!item) {
      results.push({ n, status: "skipped", detail: "no such item in this proposal" });
      continue;
    }
    if (item.status === "trashed") {
      results.push({ n, status: "skipped", detail: "already moved to Trash" });
      continue;
    }
    if (item.app && (await platform.isProcessRunning(item.app))) {
      item.status = "skipped";
      item.outcome = `${item.app} is running — quit it and try again`;
      results.push({ n, status: item.status, detail: item.outcome });
      continue;
    }
    const done: string[] = [];
    const problems: string[] = [];
    for (const fp of item.paths) {
      const verdict = await assertSafe(fp.path);
      if (!verdict.ok) {
        problems.push(`${tildify(fp.path)}: ${verdict.reason}`);
        continue;
      }
      const st = await fs.promises.lstat(fp.path);
      if (st.ino !== fp.ino) {
        problems.push(`${tildify(fp.path)}: was replaced by something else since the proposal`);
        continue;
      }
      // Caches change constantly; user content must not have changed since approval was asked.
      if (item.tier === "review" && Math.abs(st.mtimeMs - fp.mtimeMs) > 1000) {
        problems.push(`${tildify(fp.path)}: modified since the proposal was shown`);
        continue;
      }
      try {
        await platform.moveToTrash([fp.path]);
        done.push(fp.path);
        freed += fp.size;
        history.push({ at: Date.now(), path: fp.path, size: fp.size, title: item.title, proposalId, action: "trashed" });
      } catch (e) {
        problems.push(`${tildify(fp.path)}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    item.status = done.length === item.paths.length ? "trashed" : done.length ? "partial" : "skipped";
    item.outcome = problems.join("; ") || undefined;
    results.push({ n, status: item.status, detail: item.outcome ?? `moved ${done.length} path(s) to Trash` });
  }
  recordHistory(history);
  writeJson(file(proposal.id), proposal);
  return { proposal, freed, results };
}
