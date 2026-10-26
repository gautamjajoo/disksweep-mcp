import crypto from "node:crypto";

/**
 * safe        - regenerates by itself (caches, logs); no user data.
 * rebuildable - can be recreated with a command or a re-download (node_modules, VM images).
 * review      - may contain the user's own stuff; only the user can decide.
 */
export type Tier = "safe" | "rebuildable" | "review";

export type Detector =
  | "rule"
  | "project-artifact"
  | "large-file"
  | "stale-download"
  | "unused-app"
  | "duplicate"
  | "app-leftover"
  | "assistant";

export interface Candidate {
  id: string;
  title: string;
  detector: Detector;
  category: string;
  tier: Tier;
  /** Everything that would move to the Trash if approved. */
  paths: string[];
  size: number;
  reason: string;
  regenerates?: string;
  lastUsed?: number;
  ruleId?: string;
  /** Process name: skip while this app is running. */
  app?: string;
}

/** Findings we explain but never act on (e.g. Docker disk image, Trash). */
export interface Advisory {
  title: string;
  path?: string;
  size: number;
  advice: string;
}

export function candidateId(detector: string, paths: string[]): string {
  const h = crypto.createHash("sha1").update(detector).update([...paths].sort().join("\n")).digest("hex");
  return `c${h.slice(0, 8)}`;
}
