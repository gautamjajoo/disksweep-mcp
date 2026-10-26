/**
 * macOS keeps a persistent journal of filesystem changes (FSEvents). By saving
 * the journal position at the start of each scan, the next scan can ask
 * "which folders changed since then?" and re-size only those.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { dataPath } from "../paths.js";
import { displayPath } from "./du.js";

type FsEvents = typeof import("fsevents");

function load(): FsEvents | undefined {
  try {
    return createRequire(import.meta.url)("fsevents") as FsEvents;
  } catch {
    return undefined;
  }
}

export function fseventsAvailable(): boolean {
  return load() !== undefined;
}

/** Current journal position, obtained by touching a marker file and catching its event. */
export async function currentEventId(timeoutMs = 4000): Promise<string | undefined> {
  const fsevents = load();
  if (!fsevents) return undefined;
  const marker = dataPath("eventmark");
  const dir = marker.slice(0, marker.lastIndexOf("/"));
  return new Promise((resolve) => {
    let done = false;
    let stop: (() => Promise<void>) | undefined;
    const finish = (id?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void stop?.();
      resolve(id);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    stop = fsevents.watch(dir, (p, _flags, id) => {
      if (p.endsWith("/eventmark")) finish(id);
    });
    // Give the stream a moment to start before generating the event.
    setTimeout(() => fs.writeFileSync(marker, String(Date.now())), 150);
  });
}

export interface ChangeSet {
  /** Folders whose contents changed. */
  dirs: Set<string>;
  /** True if the journal can't be trusted (dropped events, wrap, root change). */
  mustFullScan: boolean;
  reason?: string;
}

/** Replay the journal for `root` since `sinceId`. */
export async function changesSince(root: string, sinceId: string, timeoutMs = 30000): Promise<ChangeSet> {
  const fsevents = load();
  if (!fsevents) return { dirs: new Set(), mustFullScan: true, reason: "fsevents unavailable" };
  const c = fsevents.constants;
  const since = Number(sinceId);
  if (!Number.isFinite(since)) return { dirs: new Set(), mustFullScan: true, reason: "invalid event id" };

  return new Promise((resolve) => {
    const dirs = new Set<string>();
    let mustFullScan = false;
    let reason: string | undefined;
    let done = false;
    let stop: (() => Promise<void>) | undefined;
    const finish = (timedOut: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void stop?.();
      if (timedOut) {
        mustFullScan = true;
        reason = "change journal replay timed out";
      }
      resolve({ dirs, mustFullScan, reason });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);

    stop = fsevents.watch(root, since, (rawPath, flags) => {
      if (flags & c.HistoryDone) {
        finish(false);
        return;
      }
      if (flags & (c.UserDropped | c.KernelDropped | c.EventIdsWrapped | c.RootChanged)) {
        mustFullScan = true;
        reason = "change journal incomplete";
      }
      const p = displayPath(rawPath.replace(/\/+$/, "") || "/");
      if (flags & c.MustScanSubDirs || flags & c.ItemIsDir) {
        dirs.add(p);
        // A created/removed/renamed folder also changes its parent's total.
        dirs.add(p.slice(0, p.lastIndexOf("/")) || "/");
      } else {
        dirs.add(p.slice(0, p.lastIndexOf("/")) || "/");
      }
    });
  });
}
