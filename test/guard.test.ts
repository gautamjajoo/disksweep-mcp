import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { assertSafe, checkPath } from "../src/safety/guard.js";
import { makeFakeHome, removeFakeHome, writeFile } from "./helpers.js";

let home: string;

beforeAll(() => {
  home = makeFakeHome("guard");
  writeFile(path.join(home, "Library/Caches/com.example.app/blob"), 4096);
  writeFile(path.join(home, "Projects/site/node_modules/pkg/index.js"));
  writeFile(path.join(home, ".zshrc"));
  writeFile(path.join(home, ".ssh/id_ed25519"));
  fs.mkdirSync(path.join(home, "Projects/site/.git/objects"), { recursive: true });
  // A symlink inside home pointing at a protected location.
  fs.symlinkSync("/System", path.join(home, "sneaky-system"));
  fs.symlinkSync(path.join(home, ".ssh"), path.join(home, "sneaky-ssh"));
});

afterAll(() => removeFakeHome(home));

describe("checkPath: OS locations are always refused", () => {
  const osPaths = [
    "/",
    "/System",
    "/System/Library/CoreServices",
    "/usr/bin",
    "/bin/ls",
    "/sbin",
    "/private/var/vm/sleepimage",
    "/var/db",
    "/etc/hosts",
    "/tmp/x",
    "/Library/Caches",
    "/Library/Application Support/Apple",
    "/opt/homebrew",
    "/Volumes/Macintosh HD",
    "/.Spotlight-V100",
    "/Applications",
    "/Applications/Utilities",
    "/Users",
    "/Users/Shared",
  ];
  for (const p of osPaths) {
    it(`refuses ${p}`, () => expect(checkPath(p).ok).toBe(false));
  }
});

describe("checkPath: protected places inside home are refused", () => {
  const rel = [
    "",
    ".zshrc",
    ".ssh/id_ed25519",
    ".gnupg",
    ".config/gh/hosts.yml",
    ".Trash/old.zip",
    ".disksweep/index.json",
    "Documents",
    "Downloads",
    "Library",
    "Library/Caches",
    "Library/Application Support",
    "Library/Keychains/login.keychain-db",
    "Library/Preferences/com.example.plist",
    "Library/Mobile Documents/com~apple~CloudDocs/file.pdf",
    "Library/CloudStorage/Dropbox/file",
    "Library/Mail/V10",
    "Library/Messages/chat.db",
    "Library/Containers/com.apple.Safari/Data",
    "Library/Group Containers/group.com.apple.notes",
    "Library/Application Support/com.apple.TCC",
    "Library/Caches/com.apple.Safari",
    "Projects/site/.git",
    "Projects/site/.git/objects",
    "Pictures/Photos Library.photoslibrary/originals/IMG_1.heic",
  ];
  for (const r of rel) {
    it(`refuses ~/${r}`, () => expect(checkPath(path.join(home, r)).ok).toBe(false));
  }
});

describe("checkPath: path tricks are refused", () => {
  it("refuses relative paths", () => expect(checkPath("Library/Caches/x").ok).toBe(false));
  it("refuses .. segments", () =>
    expect(checkPath(`${home}/Library/Caches/x/../../Keychains`).ok).toBe(false));
  it("refuses duplicate slashes", () => expect(checkPath(`${home}//Library/Caches/x`).ok).toBe(false));
  it("refuses NUL bytes", () => expect(checkPath(`${home}/Library/Caches/x\0`).ok).toBe(false));
});

describe("checkPath: ordinary junk is allowed", () => {
  const rel = [
    "Library/Caches/com.example.app",
    "Library/Application Support/Claude/vm_bundles",
    "Library/Containers/com.apple.mail/Data/Library/Mail Downloads/abc",
    "Projects/site/node_modules",
    "Downloads/installer.dmg",
    ".npm/_cacache",
    "Pictures/Old Library.photoslibrary",
  ];
  for (const r of rel) {
    it(`allows ~/${r}`, () => expect(checkPath(path.join(home, r))).toEqual({ ok: true }));
  }
  it("allows a third-party app bundle path", () =>
    expect(checkPath("/Applications/SomeApp.app")).toEqual({ ok: true }));
});

describe("assertSafe: on-disk verification", () => {
  it("allows a real cache folder", async () => {
    expect(await assertSafe(path.join(home, "Library/Caches/com.example.app"))).toEqual({ ok: true });
  });
  it("refuses something that no longer exists", async () => {
    expect((await assertSafe(path.join(home, "Library/Caches/gone"))).ok).toBe(false);
  });
  it("refuses walking through a symlink to /System", async () => {
    expect((await assertSafe(path.join(home, "sneaky-system/Library"))).ok).toBe(false);
  });
  it("refuses walking through a symlink to ~/.ssh", async () => {
    expect((await assertSafe(path.join(home, "sneaky-ssh/id_ed25519"))).ok).toBe(false);
  });
  it("refuses Apple's own apps", async () => {
    expect((await assertSafe("/Applications/Safari.app")).ok).toBe(false);
  });
  it("refuses SIP-restricted system files even if the path check were bypassed", async () => {
    const { verifyOnDisk } = await import("../src/safety/guard.js");
    expect((await verifyOnDisk("/System/Library")).ok).toBe(false);
    expect((await verifyOnDisk("/bin/ls")).ok).toBe(false);
  });
  it("refuses user-immutable (locked) files", async () => {
    const locked = path.join(home, "Downloads/locked.bin");
    writeFile(locked);
    const { execFileSync } = await import("node:child_process");
    execFileSync("/usr/bin/chflags", ["uchg", locked]);
    try {
      expect((await assertSafe(locked)).ok).toBe(false);
    } finally {
      execFileSync("/usr/bin/chflags", ["nouchg", locked]);
    }
  });
});

describe("red team: APFS is case-insensitive (review finding #1)", () => {
  const variants = ["library", "LIBRARY", "desktop", "Library/keychains", "Library/KEYCHAINS/login.keychain-db", "LIBRARY/Preferences",
    "Library/Containers/COM.APPLE.Safari", "Projects/site/.GIT", ".SSH", ".Ssh/id_ed25519", "Library/caches"];
  for (const v of variants) {
    it(`refuses ~/${v}`, async () => {
      expect(checkPath(path.join(home, v)).ok).toBe(false);
      expect((await assertSafe(path.join(home, v))).ok).toBe(false);
    });
  }
  it("refuses a case-variant spelling even of something allowed (exact spelling only)", () => {
    expect(checkPath(path.join(home, "library/caches/com.example.app")).ok).toBe(false);
    expect(checkPath(path.join(home, "Library/Caches/COM.EXAMPLE.APP")).ok).toBe(false);
    expect(checkPath(path.join(home, "Library/Caches/com.example.app")).ok).toBe(true);
  });
  it("refuses decomposed-Unicode spellings of protected names", () => {
    // "é" written as e + combining accent must not dodge a comparison.
    expect(checkPath(path.join(home, "Library/Keychains".normalize("NFD")))).toMatchObject({ ok: false });
  });
});

describe("red team: trailing slash would follow a symlink (review finding #2)", () => {
  it("refuses a symlink path with a trailing slash", async () => {
    fs.mkdirSync(path.join(home, "Downloads"), { recursive: true });
    fs.symlinkSync(path.join(home, ".ssh"), path.join(home, "Downloads/lnk"));
    expect(checkPath(path.join(home, "Downloads/lnk") + "/").ok).toBe(false);
    expect((await assertSafe(path.join(home, "Downloads/lnk") + "/")).ok).toBe(false);
  });
  it("expandHome strips trailing slashes", async () => {
    const { expandHome } = await import("../src/paths.js");
    expect(expandHome("~/Downloads/lnk/")).toBe(path.join(home, "Downloads/lnk"));
  });
});

describe("user keep decisions ignore case too", () => {
  it("a keep on ~/Documents/x also covers ~/documents/x", async () => {
    const { remember, isExcluded } = await import("../src/memory.js");
    remember(path.join(home, "Documents/x"), "keep", "keep");
    expect(isExcluded(path.join(home, "documents/X/y"))).toBeTruthy();
  });
});
