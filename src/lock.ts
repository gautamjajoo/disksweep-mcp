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
  const mine: LockInfo = { pid: process.pid, since: Date.now(), what };
  for (let attempt = 0; attempt < 3; attempt++) {
    // Write the full record first, then link it into place: link() fails if the
    // lock exists, so nobody can ever observe a half-written lock file.
    const tmp = `${file}.${process.pid}.${Date.now()}.${attempt}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(mine));
    try {
      fs.linkSync(tmp, file);
      fs.rmSync(tmp, { force: true });
      return { ok: true, release: releaser(file) };
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = readLock(name);
    if (holder && holder.pid !== process.pid) return { ok: false, holder };
    // Owner is dead. Move the stale file aside (atomic) and check we moved the
    // stale one, not a lock someone else took in the meantime.
    const aside = `${file}.stale.${process.pid}.${Date.now()}`;
    try {
      fs.renameSync(file, aside);
    } catch {
      continue; // someone else got there first; retry
    }
    try {
      const moved = JSON.parse(fs.readFileSync(aside, "utf8")) as LockInfo;
      if (alive(moved.pid) && moved.pid !== process.pid) {
        try {
          fs.linkSync(aside, file); // put the live lock back
        } catch {
          /* yet another holder exists; theirs stands */
        }
        fs.rmSync(aside, { force: true });
        return { ok: false, holder: moved };
      }
    } catch {
      /* unreadable stale file */
    }
    fs.rmSync(aside, { force: true });
  }
  return { ok: false, holder: readLock(name) ?? { pid: 0, since: Date.now(), what: "another disksweep process" } };
}

function releaser(file: string): () => void {
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
  return release;
}
