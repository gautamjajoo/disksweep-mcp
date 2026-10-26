import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { makeFakeHome, removeFakeHome } from "./helpers.js";
import { tryLock, withLockSync } from "../src/lock.js";
import { dataPath } from "../src/paths.js";

let home: string;
beforeAll(() => {
  home = makeFakeHome("lock");
});
afterAll(() => removeFakeHome(home));

describe("cross-process lock", () => {
  it("lets only one holder in, then releases", () => {
    const a = tryLock("scan", "first");
    expect(a.ok).toBe(true);
    // Simulate another process holding it: rewrite the owner to a live foreign pid.
    const other = spawn("/bin/sleep", ["5"]);
    fs.writeFileSync(dataPath("scan.lock"), JSON.stringify({ pid: other.pid, since: Date.now(), what: "other scan" }));
    const b = tryLock("scan", "second");
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.holder.what).toBe("other scan");
    other.kill();
  });

  it("takes over a stale lock left by a dead process", async () => {
    const dead = spawn("/usr/bin/true");
    await new Promise((r) => dead.on("exit", r));
    fs.writeFileSync(dataPath("scan.lock"), JSON.stringify({ pid: dead.pid, since: 0, what: "crashed scan" }));
    const l = tryLock("scan", "new scan");
    expect(l.ok).toBe(true);
    if (l.ok) l.release();
    expect(fs.existsSync(dataPath("scan.lock"))).toBe(false);
  });

  it("withLockSync runs and releases", () => {
    expect(withLockSync("memory", "test", () => 42)).toBe(42);
    expect(fs.existsSync(path.join(process.env.DISKSWEEP_DATA_DIR!, "memory.lock"))).toBe(false);
  });
});
