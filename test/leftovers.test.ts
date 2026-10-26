import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeFakeHome, removeFakeHome, writeFile } from "./helpers.js";
import { leftoversFor, discoverUninstalled } from "../src/detect/leftovers.js";
import { createProposal } from "../src/proposal.js";

let home: string;
const old = (p: string, days = 200) => {
  const t = new Date(Date.now() - days * 86_400_000);
  for (const f of walk(p)) fs.utimesSync(f, t, t);
};
/** Wait until a process launched from `bundleName` is visible to pgrep (first exec of a copied binary can be slow). */
async function waitForProcess(bundleName: string): Promise<void> {
  const { processesFrom } = await import("../src/detect/leftovers.js");
  for (let i = 0; i < 50; i++) {
    if ((await processesFrom(bundleName)).some((p) => p.bundleExists)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`process from ${bundleName}.app never appeared`);
}

function* walk(p: string): Generator<string> {
  const st = fs.lstatSync(p);
  if (st.isDirectory()) for (const n of fs.readdirSync(p)) yield* walk(path.join(p, n));
  yield p;
}

beforeAll(() => {
  home = makeFakeHome("leftovers");
  process.env.DISKSWEEP_DATA_DIR = `${home}-data`;
  const apps = `${home}-apps`;
  fs.mkdirSync(path.join(apps, "Installed.app/Contents"), { recursive: true });
  fs.writeFileSync(path.join(apps, "Installed.app/Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.installed</string></dict></plist>`);
  process.env.DISKSWEEP_APP_DIRS = apps;

  const L = (rel: string) => path.join(home, "Library", rel);
  // Cursor leftovers, old and tiny.
  writeFile(L("Caches/com.todesktop.230313mzl4w4u92.ShipIt/update/blob"), 5000);
  writeFile(L("Caches/com.todesktop.230313mzl4w4u92/Cache.db"), 3000);
  writeFile(L("Application Support/Caches/cursor-updater/pending/x"), 2000);
  writeFile(L("HTTPStorages/com.todesktop.230313mzl4w4u92.binarycookies"), 100);
  writeFile(L("Preferences/com.todesktop.230313mzl4w4u92.plist"), 100);
  writeFile(path.join(home, ".cursor-tutor/readme"), 10);
  fs.mkdirSync(path.join(home, "Downloads/Install Cursor.app/Contents"), { recursive: true });
  for (const p of ["Library", ".cursor-tutor", "Downloads"]) old(path.join(home, p));
  // Shared folder still in use by another tool: must be flagged, not proposed.
  writeFile(path.join(home, ".cursor/skills/some-skill/SKILL.md"), 100);
  // Traps: must NOT match "cursor".
  writeFile(path.join(home, "Projects/plugin/.cursor-plugin/plugin.json"), 100);
  writeFile(path.join(home, "Downloads/tkMacOSXCursors.h"), 100);
  writeFile(L("Application Support/Precursor Notes/db"), 100);
  // Installed app's data: never a leftover.
  writeFile(L("Caches/com.example.installed/c"), 100);
  old(path.join(home, "Library"));
});

afterAll(() => {
  for (const d of [home, `${home}-data`, `${home}-apps`]) removeFakeHome(d);
  delete process.env.DISKSWEEP_APP_DIRS;
});

describe("app_leftovers", () => {
  it("finds every Cursor leftover, however small, via bundle id and whole-word names", async () => {
    const r = await leftoversFor("Cursor");
    expect(r.status).toBe("leftover");
    const rel = r.items.map((i) => path.relative(home, i.path)).sort();
    expect(rel).toEqual(
      [
        ".cursor",
        ".cursor-tutor",
        "Downloads/Install Cursor.app",
        "Library/Application Support/Caches/cursor-updater",
        "Library/Caches/com.todesktop.230313mzl4w4u92",
        "Library/Caches/com.todesktop.230313mzl4w4u92.ShipIt",
        "Library/HTTPStorages/com.todesktop.230313mzl4w4u92.binarycookies",
        "Library/Preferences/com.todesktop.230313mzl4w4u92.plist",
      ].sort(),
    );
  });

  it("never proposes protected settings or folders something still writes to", async () => {
    const r = await leftoversFor("Cursor");
    const proposed = r.candidates.map((c) => path.relative(home, c.paths[0]));
    expect(proposed).not.toContain("Library/Preferences/com.todesktop.230313mzl4w4u92.plist");
    expect(proposed).not.toContain(".cursor"); // skills/ written recently
    expect(proposed).toContain("Library/Caches/com.todesktop.230313mzl4w4u92.ShipIt");
    expect(r.items.find((i) => i.path.endsWith("/.cursor"))?.contains).toEqual(["skills/"]);
  });

  it("leftover ids can go straight into a proposal", async () => {
    const r = await leftoversFor("Cursor");
    const { proposal, rejected } = await createProposal(r.candidates.map((c) => c.id), []);
    expect(rejected).toEqual([]);
    expect(proposal.items.length).toBe(r.candidates.length);
  });

  it("treats an installed app's data as live, not leftovers", async () => {
    const r = await leftoversFor("Installed");
    expect(r.status).toBe("installed");
    expect(r.candidates).toEqual([]);
  });

  it("discovery groups by app and skips installed apps", async () => {
    const reports = await discoverUninstalled();
    const names = reports.map((r) => r.app);
    expect(names).toContain("Cursor");
    expect(names).not.toContain("com.example.installed");
    // Each path belongs to one app only.
    const all = reports.flatMap((r) => r.items.map((i) => i.path));
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("an app you just deleted (used until today, a helper still running)", () => {
  it("still finds its data, keeps the CLI's files, and reports the stale process", async () => {
    const { spawn } = await import("node:child_process");
    const L = (rel: string) => path.join(home, "Library", rel);
    // "Claude" desktop data written today, plus the Claude Code CLI's own files.
    writeFile(L("Application Support/Claude/vm_bundles/disk.img"), 4000);
    writeFile(L("Caches/com.anthropic.claudefordesktop/c"), 100);
    writeFile(path.join(home, ".claude/settings.json"), 100);
    writeFile(path.join(home, ".claude.json"), 100);
    // A helper still running from a bundle that has since been deleted.
    const bundle = path.join(`${home}-apps`, "Claude.app/Contents/MacOS");
    fs.mkdirSync(bundle, { recursive: true });
    fs.copyFileSync("/bin/sleep", path.join(bundle, "helper"));
    const proc = spawn(path.join(bundle, "helper"), ["30"], { stdio: "ignore" });
    await waitForProcess("Claude");
    fs.rmSync(path.join(`${home}-apps`, "Claude.app"), { recursive: true });
    try {
      const r = await leftoversFor("Claude");
      expect(r.status).toBe("leftover");
      const proposed = r.candidates.map((c) => path.relative(home, c.paths[0]));
      expect(proposed).toContain("Library/Application Support/Claude");
      expect(proposed).toContain("Library/Caches/com.anthropic.claudefordesktop");
      const all = r.items.map((i) => path.relative(home, i.path));
      expect(all).not.toContain(".claude");
      expect(all).not.toContain(".claude.json");
      expect(r.staleProcesses?.map((p) => p.pid)).toContain(proc.pid);
    } finally {
      proc.kill();
    }
  });

  it("discovery (no app named) does not suggest recently active data on its own", async () => {
    const reports = await discoverUninstalled();
    const claude = reports.find((r) => r.app === "Claude");
    expect(claude?.status).toBe("recently-active");
    expect(claude?.candidates).toEqual([]);
  });

  it("an app running from an existing bundle counts as installed", async () => {
    const { spawn } = await import("node:child_process");
    const bundle = path.join(`${home}-apps`, "Fotor.app/Contents/MacOS");
    fs.mkdirSync(bundle, { recursive: true });
    fs.copyFileSync("/bin/sleep", path.join(bundle, "fotor"));
    const proc = spawn(path.join(bundle, "fotor"), ["30"], { stdio: "ignore" });
    await waitForProcess("Fotor");
    try {
      expect((await leftoversFor("Fotor")).status).toBe("installed");
    } finally {
      proc.kill();
    }
  });
});
