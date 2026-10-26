import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeFakeHome, removeFakeHome, writeFile } from "./helpers.js";
import { startScan } from "../src/scan/scanner.js";
import { analyse } from "../src/analyse.js";
import { createProposal, loadProposal, trashApproved } from "../src/proposal.js";
import { inspect } from "../src/inspect.js";
import { remember, loadHistory } from "../src/memory.js";
import { writeJson, dataPath } from "../src/paths.js";

const MB = 1000 * 1000;
let home: string;
let trash: string;
const old = (p: string, days: number) => {
  const t = new Date(Date.now() - days * 86_400_000);
  fs.utimesSync(p, t, t);
};

beforeAll(async () => {
  home = makeFakeHome("flow");
  const data = `${home}-data`;
  trash = `${home}-trash`;
  process.env.DISKSWEEP_DATA_DIR = data;
  process.env.DISKSWEEP_TEST_TRASH = trash;
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(trash, { recursive: true });
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ scanRoot: home, minNodeBytes: 1 * MB }));

  // Known junk (rule): Codex temp folder.
  writeFile(path.join(home, ".codex/.tmp/blob.bin"), 12 * MB);
  // Stale project with node_modules.
  const proj = path.join(home, "Projects/old-site");
  writeFile(path.join(proj, "package.json"), 100);
  writeFile(path.join(proj, "index.js"), 100);
  writeFile(path.join(proj, "node_modules/big/dep.bin"), 55 * MB);
  for (const f of ["package.json", "index.js", "node_modules", ""]) old(path.join(proj, f), 120);
  // Something no rule knows: the assistant has to investigate it.
  writeFile(path.join(home, "Weird/recordings/a.wav"), 3 * MB);
  // Protected things.
  writeFile(path.join(home, ".ssh/id_ed25519"), 400);

  await startScan("full", home).promise;
});

afterAll(() => {
  for (const d of [home, `${home}-data`, trash]) removeFakeHome(d);
  delete process.env.DISKSWEEP_TEST_TRASH;
});

describe("analyse → propose → approve → trash", () => {
  let proposalId = "";

  it("finds rule-based junk and stale project folders", async () => {
    const a = await analyse(undefined, ["rules"]);
    expect(a.candidates.map((c) => c.ruleId)).toContain("codex-temp");
    const { loadIndex } = await import("../src/scan/scanner.js");
    const b = await analyse(loadIndex(), ["rules", "projects"]);
    const nm = b.candidates.find((c) => c.detector === "project-artifact");
    expect(nm?.paths[0]).toBe(path.join(home, "Projects/old-site/node_modules"));
    expect(nm?.tier).toBe("rebuildable");
  });

  it("inspect explains an unknown folder without reading contents", async () => {
    const r = await inspect(path.join(home, "Weird"));
    expect(r.kind).toBe("folder");
    expect(r.types[0].ext).toBe("wav");
    expect(r.signals.join(" ")).toMatch(/media/i);
    expect(r.actionable).toBe(true);
    const s = await inspect(path.join(home, ".ssh"));
    expect(s.actionable).toBe(false);
  });

  it("builds a proposal, rejecting protected and unexplained items", async () => {
    const { lastAnalysis } = await import("../src/analyse.js");
    const ids = lastAnalysis()!.candidates.map((c) => c.id);
    const { proposal, rejected } = await createProposal(ids, [
      { path: path.join(home, "Weird"), reason: "Old test recordings the user said they don't need" },
      { path: path.join(home, ".ssh"), reason: "trying something bad" },
      { path: "/System/Library", reason: "nope" },
      { path: path.join(home, "Projects/old-site/index.js"), reason: "" },
    ]);
    proposalId = proposal.id;
    expect(proposal.items.map((i) => i.title)).toEqual(expect.arrayContaining(["Weird"]));
    expect(proposal.items.find((i) => i.title === "Weird")?.tier).toBe("review");
    expect(rejected.join("\n")).toMatch(/\.ssh/);
    expect(rejected.join("\n")).toMatch(/System/);
    expect(rejected.join("\n")).toMatch(/reason is required/);
  });

  it("moves only the approved numbers to the Trash and records history", async () => {
    const p = loadProposal(proposalId)!;
    const nm = p.items.find((i) => i.paths[0].path.endsWith("node_modules"))!;
    const weird = p.items.find((i) => i.title === "Weird")!;
    const r = await trashApproved(proposalId, [nm.n]);
    expect(r.results[0].status).toBe("trashed");
    expect(fs.existsSync(nm.paths[0].path)).toBe(false);
    expect(fs.existsSync(weird.paths[0].path)).toBe(true); // not approved, untouched
    expect(fs.readdirSync(trash).some((n) => n.startsWith("node_modules"))).toBe(true);
    expect(loadHistory().some((h) => h.path === nm.paths[0].path)).toBe(true);
  });

  it("skips review items that changed after the user saw them", async () => {
    const p = loadProposal(proposalId)!;
    const weird = p.items.find((i) => i.title === "Weird")!;
    await new Promise((r) => setTimeout(r, 1100));
    writeFile(path.join(home, "Weird/new-file.txt"), 10);
    const r = await trashApproved(proposalId, [weird.n]);
    expect(r.results[0].status).toBe("skipped");
    expect(fs.existsSync(path.join(home, "Weird"))).toBe(true);
  });

  it("refuses a tampered proposal pointing at protected paths", async () => {
    const p = loadProposal(proposalId)!;
    const st = fs.lstatSync(path.join(home, ".ssh"));
    p.items.push({
      n: 99, title: "evil", tier: "safe", reason: "x", source: "detector", status: "pending", size: 1,
      paths: [{ path: path.join(home, ".ssh"), size: 1, ino: st.ino, mtimeMs: st.mtimeMs }],
    });
    p.items.push({
      n: 98, title: "evil2", tier: "safe", reason: "x", source: "detector", status: "pending", size: 1,
      paths: [{ path: "/System/Library", size: 1, ino: fs.lstatSync("/System/Library").ino, mtimeMs: 0 }],
    });
    writeJson(dataPath("proposals", `${p.id}.json`), p);
    const r = await trashApproved(proposalId, [99, 98]);
    expect(r.results.every((x) => x.status === "skipped")).toBe(true);
    expect(fs.existsSync(path.join(home, ".ssh/id_ed25519"))).toBe(true);
  });

  it("rejects unknown proposal ids", async () => {
    await expect(trashApproved("p00000000", [1])).rejects.toThrow(/Unknown proposal/);
    await expect(trashApproved("../../etc", [1])).rejects.toThrow(/Unknown proposal/);
  });

  it("never suggests something the user chose to keep", async () => {
    remember(path.join(home, ".codex/.tmp"), "user wants to keep", "keep");
    const a = await analyse(undefined, ["rules"]);
    expect(a.candidates.some((c) => c.ruleId === "codex-temp")).toBe(false);
    expect(a.excluded).toBeGreaterThan(0);
  });
});
