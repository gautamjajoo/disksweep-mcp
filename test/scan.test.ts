import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeFakeHome, removeFakeHome, writeFile } from "./helpers.js";
import { startScan, loadIndex } from "../src/scan/scanner.js";
import { findExact } from "../src/scan/tree.js";

const MB = 1000 * 1000;
let home: string;

const duBytes = (p: string) => Number(execFileSync(path.resolve("native/bin/dsize"), ["-s", p]).toString().split("\t")[0]);

beforeAll(() => {
  home = makeFakeHome("scan");
  // Keep disksweep's own files outside the scanned folder so totals are stable.
  const data = `${home}-data`;
  process.env.DISKSWEEP_DATA_DIR = data;
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ scanRoot: home, minNodeBytes: 1 * MB }));
  writeFile(path.join(home, "Big/a.bin"), 3 * MB);
  writeFile(path.join(home, "Big/deep/er/b.bin"), 2 * MB);
  writeFile(path.join(home, "Small/c.txt"), 1000);
  for (let i = 0; i < 50; i++) writeFile(path.join(home, `Many/f${i}.dat`), 40_000);
  // A hard link must be counted once.
  fs.linkSync(path.join(home, "Big/a.bin"), path.join(home, "Big/a-link.bin"));
  // Symlinks are not followed.
  fs.symlinkSync("/usr", path.join(home, "usr-link"));
});

afterAll(() => {
  removeFakeHome(home);
  removeFakeHome(`${home}-data`);
});

describe("full scan", () => {
  it("matches du for every indexed folder and counts hard links once", async () => {
    const job = startScan("full", home);
    const idx = await job.promise;
    expect(idx.tree.path).toBe(home);
    expect(idx.tree.size).toBe(duBytes(home));
    const big = findExact(idx.tree, path.join(home, "Big"))!;
    expect(big.size).toBe(duBytes(path.join(home, "Big")));
    expect(big.size).toBeLessThan(6 * MB); // 3 MB + 2 MB, link not double counted
    expect(findExact(idx.tree, path.join(home, "Big/deep/er"))).toBeDefined();
    // Below threshold: aggregated into the parent, not indexed.
    expect(findExact(idx.tree, path.join(home, "Small"))).toBeUndefined();
    expect(findExact(idx.tree, path.join(home, "Many"))).toBeDefined(); // 50 × 40 KB = 2 MB
    expect(loadIndex()?.tree.size).toBe(idx.tree.size);
  });
});

describe("incremental scan", () => {
  it("picks up a change deep in the tree using the change journal", async () => {
    const first = loadIndex()!;
    expect(first.eventId).toBeDefined();
    writeFile(path.join(home, "Big/deep/er/new.bin"), 4 * MB);
    writeFile(path.join(home, "Fresh/x.bin"), 2 * MB);
    fs.rmSync(path.join(home, "Many"), { recursive: true });
    await new Promise((r) => setTimeout(r, 1500)); // let FSEvents flush

    const job = startScan("incremental", home);
    const idx = await job.promise;
    expect(job.mode).toBe("incremental");
    expect(idx.tree.size).toBe(duBytes(home));
    expect(findExact(idx.tree, path.join(home, "Big/deep/er"))!.size).toBe(duBytes(path.join(home, "Big/deep/er")));
    expect(findExact(idx.tree, path.join(home, "Fresh"))).toBeDefined();
    expect(findExact(idx.tree, path.join(home, "Many"))).toBeUndefined();
  }, 60_000);
});

describe("dsize engine", () => {
  const dsize = path.resolve("native/bin/dsize");
  const sysDu = (p: string) => Number(execFileSync("/usr/bin/du", ["-sxk", p]).toString().split("\t")[0]) * 1024;

  it("agrees with du when there are no clones", () => {
    const dir = path.join(home, "Big");
    expect(Number(execFileSync(dsize, ["-s", dir]).toString().split("\t")[0])).toBe(sysDu(dir));
  });

  it("counts exact APFS clones once, where du counts them repeatedly", () => {
    const dir = path.join(home, "Clones");
    writeFile(path.join(dir, "orig.bin"), 8 * MB);
    for (const n of ["c1", "c2", "c3"]) execFileSync("/bin/cp", ["-c", path.join(dir, "orig.bin"), path.join(dir, `${n}.bin`)]);
    const ours = Number(execFileSync(dsize, ["-s", dir]).toString().split("\t")[0]);
    expect(ours).toBeLessThan(9 * MB);
    expect(sysDu(dir)).toBeGreaterThan(30 * MB);
  });
});
