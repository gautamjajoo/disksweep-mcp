/**
 * Known-junk rules, loaded from rules/*.json so anyone can contribute rules
 * without touching code. Rules only *suggest*; the guard decides what may ever
 * be acted on.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "../paths.js";
import { Advisory, Candidate, Tier, candidateId } from "./types.js";
import { Sizer } from "./sizes.js";

export interface Rule {
  id: string;
  name: string;
  category: string;
  tier: Tier;
  /** Paths; a segment may contain `*` (e.g. "~/Library/Caches/*.ShipIt"). */
  paths: string[];
  reason: string;
  regenerates?: string;
  /** Only match items whose modification time is older than this. */
  olderThanDays?: number;
  /** Ignore matches smaller than this (default 20 MB). */
  minBytes?: number;
  /** Combine all matches into a single suggestion. */
  group?: boolean;
  /** Skip while this process is running. */
  app?: string;
  /** Broad catch-all rule: evaluated last, never overlaps more specific rules. */
  generic?: boolean;
  /** Paths a pattern may match that this rule must skip. */
  exclude?: string[];
  /** Never acted on; explained with this advice instead. */
  advice?: string;
  platforms?: string[];
}

const RULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../rules");

export function loadRules(dir = RULES_DIR): Rule[] {
  const rules: Rule[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const pack = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { rules?: Rule[] };
    if (!Array.isArray(pack.rules)) continue; // other data files (app-identities.json)
    for (const r of pack.rules) {
      if (r.platforms && !r.platforms.includes(process.platform)) continue;
      rules.push(r);
    }
  }
  return rules;
}

/** Expand a pattern with `*` segments into existing paths (no symlink following). */
export async function expandPattern(pattern: string): Promise<string[]> {
  const abs = expandHome(pattern);
  const parts = abs.split("/").filter(Boolean);
  let current = ["/"];
  for (const part of parts) {
    const next: string[] = [];
    if (!part.includes("*")) {
      for (const base of current) next.push(path.join(base, part));
    } else {
      const re = new RegExp("^" + part.split("*").map(escapeRe).join(".*") + "$");
      for (const base of current) {
        let names: string[];
        try {
          names = await fs.promises.readdir(base);
        } catch {
          continue;
        }
        for (const n of names) if (re.test(n)) next.push(path.join(base, n));
      }
    }
    current = next;
  }
  const existing: string[] = [];
  for (const p of current) {
    try {
      const st = await fs.promises.lstat(p);
      if (!st.isSymbolicLink()) existing.push(p);
    } catch {
      /* not there */
    }
  }
  return existing;
}

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

const overlaps = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

export interface RuleResults {
  candidates: Candidate[];
  advisories: Advisory[];
}

export async function runRules(rules: Rule[], sizer: Sizer, claimed: string[]): Promise<RuleResults> {
  const candidates: Candidate[] = [];
  const advisories: Advisory[] = [];
  const ordered = [...rules.filter((r) => !r.generic), ...rules.filter((r) => r.generic)];

  for (const rule of ordered) {
    const min = rule.minBytes ?? 20 * 1000 * 1000;
    const matches: { path: string; size: number; mtime: number }[] = [];
    for (const pattern of rule.paths) {
      for (const p of await expandPattern(pattern)) {
        if (claimed.some((c) => overlaps(c, p))) continue;
        if (sizer.belowThreshold(p, min) && min > 0) continue;
        let mtime = 0;
        try {
          mtime = (await fs.promises.lstat(p)).mtimeMs;
        } catch {
          continue;
        }
        if (rule.exclude?.some((x) => expandHome(x) === p)) continue;
        // Age = newest change anywhere inside, not just the folder's own timestamp.
        const { size, newest } = await sizer.measure(p);
        mtime = Math.max(mtime, newest ?? 0);
        if (rule.olderThanDays && Date.now() - mtime < rule.olderThanDays * 86_400_000) continue;
        if (!rule.group && size < min) continue;
        matches.push({ path: p, size, mtime });
      }
    }
    if (rule.group) {
      const total = matches.reduce((s, m) => s + m.size, 0);
      if (matches.length && total >= min) {
        if (rule.advice) {
          advisories.push({ title: rule.name, size: total, advice: rule.advice, path: matches[0].path });
        } else {
          candidates.push(toCandidate(rule, matches.map((m) => m.path), total, Math.max(...matches.map((m) => m.mtime))));
        }
        claimed.push(...matches.map((m) => m.path));
      }
      continue;
    }
    for (const m of matches) {
      if (rule.advice) advisories.push({ title: rule.name, path: m.path, size: m.size, advice: rule.advice });
      else candidates.push(toCandidate(rule, [m.path], m.size, m.mtime));
      claimed.push(m.path);
    }
  }
  return { candidates, advisories };
}

function toCandidate(rule: Rule, paths: string[], size: number, mtime: number): Candidate {
  const title =
    paths.length === 1 && rule.paths.some((p) => p.includes("*"))
      ? `${rule.name}: ${path.basename(paths[0])}`
      : paths.length > 1
        ? `${rule.name} (${paths.length} items)`
        : rule.name;
  return {
    id: candidateId(`rule:${rule.id}`, paths),
    title,
    detector: "rule",
    category: rule.category,
    tier: rule.tier,
    paths,
    size,
    reason: rule.reason,
    regenerates: rule.regenerates,
    lastUsed: mtime || undefined,
    ruleId: rule.id,
    app: rule.app,
  };
}
