import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeFakeHome, removeFakeHome, writeFile } from "./helpers.js";
import { duTree } from "../src/scan/du.js";
import { TopFiles } from "../src/scan/tree.js";
import { rememberShownList, emptyShownTrash } from "../src/trash.js";
import { runRules, Rule } from "../src/detect/rules.js";
import { Sizer } from "../src/detect/sizes.js";

let home: string;
beforeAll(() => {
  home = makeFakeHome("review");
});
afterAll(() => removeFakeHome(home));

describe("file names containing newlines cannot forge index records (finding #4)", () => {
  it("a crafted name is one record, not a fake 1 TB entry", async () => {
    const victim = path.join(home, "Documents/thesis.pdf");
    writeFile(victim, 1000);
    const evil = path.join(home, "Downloads", `x\n999999999999\t0\t${victim}`);
    writeFile(evil, 1000);
    const top = new TopFiles(50, 0);
    await duTree([home], { minNodeBytes: 0, topFiles: top });
    const forged = top.list().find((f) => f.path === victim && f.size > 1e9);
    expect(forged).toBeUndefined();
    expect(top.list().some((f) => f.path === evil)).toBe(true);
  });
});

describe("empty_old_trash only deletes the list the user saw (finding #3)", () => {
  it("rejects unknown tokens and deletes exactly the shown items", async () => {
    const trash = path.join(home, ".Trash");
    writeFile(path.join(trash, "shown.bin"), 100);
    writeFile(path.join(trash, "not-shown.bin"), 100);
    const ino = fs.lstatSync(path.join(trash, "shown.bin")).ino;
    const token = rememberShownList([{ path: path.join(trash, "shown.bin"), size: 100, ino }]);
    expect((await emptyShownTrash("tdeadbeef")).errors[0]).toMatch(/Unknown/);
    const r = await emptyShownTrash(token);
    expect(r.removed.map((x) => path.basename(x.path))).toEqual(["shown.bin"]);
    expect(fs.existsSync(path.join(trash, "not-shown.bin"))).toBe(true);
    expect((await emptyShownTrash(token)).errors[0]).toMatch(/Unknown/); // single use
  });
  it("skips an item replaced since the list was shown", async () => {
    const trash = path.join(home, ".Trash");
    writeFile(path.join(trash, "swap.bin"), 100);
    const token = rememberShownList([{ path: path.join(trash, "swap.bin"), size: 100, ino: 1 }]);
    const r = await emptyShownTrash(token);
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(path.join(trash, "swap.bin"))).toBe(true);
  });
});

describe("'older than N days' looks inside folders (finding #6)", () => {
  it("does not flag an old folder whose contents changed recently", async () => {
    const dir = path.join(home, "Work/old-but-active");
    writeFile(path.join(dir, "deep/inside/file.txt"), 50_000_000);
    const t = new Date(Date.now() - 100 * 86_400_000);
    fs.utimesSync(dir, t, t); // folder's own timestamp says 100 days old
    const rule: Rule = { id: "t", name: "t", category: "t", tier: "review", paths: [path.join(home, "Work/*")], reason: "t", olderThanDays: 30, minBytes: 1 };
    const r = await runRules([rule], new Sizer(undefined), []);
    expect(r.candidates).toEqual([]);
  });
});
