/**
 * Cross-process lock. Claude Code, Codex and a cron `report` may all run
 * disksweep at once; only one may scan (and write the index) at a time.
 * A lock whose owner process has died is treated as stale and taken over.
 */
import fs from "node:fs";
import { dataPath } from "./paths.js";

export interface LockInfo {
  pid: number;
  since: number;
  what: string;
}

const lockFile = (name: string) => dataPath(`${name}.lock`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(name: string): LockInfo | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(lockFile(name), "utf8")) as LockInfo;
    return alive(info.pid) ? info : undefined;
  } catch {
    return undefined;
  }
}

/** Run `fn` under a short-lived lock, waiting up to `waitMs` for another process to finish. */
export function withLockSync<T>(name: string, what: string, fn: () => T, waitMs = 3000): T {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const l = tryLock(name, what);
    if (l.ok) {
      try {
        return fn();
      } finally {
        l.release();
      }
    }
    if (Date.now() > deadline) throw new Error(`disksweep data is busy (${l.holder.what}, pid ${l.holder.pid}); try again`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

/** Try to take the lock; returns the current holder if someone else has it. */
export function tryLock(name: string, what: string): { ok: true; release: () => void } | { ok: false; holder: LockInfo } {
  const file = lockFile(name);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, since: Date.now(), what } satisfies LockInfo));
      fs.closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off("exit", release);
        try {
          const cur = JSON.parse(fs.readFileSync(file, "utf8")) as LockInfo;
          if (cur.pid === process.pid) fs.rmSync(file, { force: true });
        } catch {
          /* already gone */
        }
      };
      process.once("exit", release);
      return { ok: true, release };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = readLock(name);
      if (holder && holder.pid !== process.pid) return { ok: false, holder };
      // Stale (owner died) or unreadable: remove and retry once.
      fs.rmSync(file, { force: true });
    }
  }
  const holder = readLock(name);
  return { ok: false, holder: holder ?? { pid: 0, since: Date.now(), what: "unknown" } };
}
