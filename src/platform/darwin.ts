import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { userHome } from "../paths.js";
import type { DiskInfo, FileFacts, Platform } from "./index.js";

const run = promisify(execFile);

async function out(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await run(cmd, args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function mdlsDate(file: string, attr: string): Promise<Date | undefined> {
  try {
    const raw = (await out("/usr/bin/mdls", ["-raw", "-name", attr, file])).trim();
    if (!raw || raw === "(null)") return undefined;
    const d = new Date(raw.replace(" +0000", "Z").replace(" ", "T"));
    return isNaN(d.getTime()) ? undefined : d;
  } catch {
    return undefined;
  }
}

export const darwin: Platform = {
  name: "macOS",

  async diskInfo(target: string): Promise<DiskInfo> {
    const s = await fs.promises.statfs(target);
    const total = s.blocks * s.bsize;
    // bavail = space available to non-root users, which is what matters here.
    const free = s.bavail * s.bsize;
    const used = total - s.bfree * s.bsize;
    return {
      mount: target,
      totalBytes: total,
      freeBytes: free,
      usedBytes: used,
      percentUsed: Math.round((used / (used + free)) * 1000) / 10,
    };
  },

  async moveToTrash(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const testTrash = process.env.DISKSWEEP_TEST_TRASH;
    if (testTrash) {
      // Test suites only: keep test files out of the user's real Trash.
      for (const p of paths) fs.renameSync(p, path.join(testTrash, `${path.basename(p)}-${Date.now()}`));
      return;
    }
    if (fs.existsSync("/usr/bin/trash")) {
      // macOS 15+: native, supports "Put Back".
      await run("/usr/bin/trash", paths);
      return;
    }
    // Older macOS: ask Finder, which also records Put Back info.
    const list = paths.map((p) => `POSIX file ${JSON.stringify(p)}`).join(", ");
    await run("/usr/bin/osascript", ["-e", `tell application "Finder" to delete {${list}}`]);
  },

  lastUsed: (file) => mdlsDate(file, "kMDItemLastUsedDate"),
  dateAdded: (file) => mdlsDate(file, "kMDItemDateAdded"),

  async fileFacts(file: string): Promise<FileFacts> {
    const raw = (await out("/usr/bin/stat", ["-f", "%Sf|%u", file])).trim();
    const [flags, uid] = raw.split("|");
    return {
      flags: flags === "-" ? [] : flags.split(","),
      uid: Number(uid),
    };
  },

  async isOsVendorApp(appPath: string): Promise<boolean> {
    try {
      const { stderr } = await run("/usr/bin/codesign", ["-dv", "--verbose=2", appPath]);
      return /Authority=Software Signing|Identifier=com\.apple\./.test(stderr);
    } catch {
      return false;
    }
  },

  async isProcessRunning(name: string): Promise<boolean> {
    try {
      await run("/usr/bin/pgrep", ["-xq", name]);
      return true;
    } catch {
      return false;
    }
  },

  trashDir: () => path.join(userHome(), ".Trash"),

  async volumes() {
    try {
      const plist = await out("/usr/sbin/diskutil", ["apfs", "list", "-plist"]);
      const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
        const child = execFile("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], (err, stdout) =>
          err ? reject(err) : resolve({ stdout }),
        );
        child.stdin?.end(plist);
      });
      type Vol = { Name: string; Roles?: string[]; CapacityInUse: number };
      const containers = (JSON.parse(stdout) as { Containers: { Volumes: Vol[] }[] }).Containers;
      // The container holding the System/Data volumes (not the hidden boot container).
      const main = containers.find((c) => c.Volumes.some((v) => v.Roles?.includes("Data") || v.Roles?.includes("System")));
      return (main?.Volumes ?? []).map((v) => ({ name: v.Name, role: v.Roles?.[0] ?? "", bytes: v.CapacityInUse }));
    } catch {
      return [];
    }
  },

  systemRoots: [
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/private",
    "/var",
    "/etc",
    "/tmp",
    "/Library",
    "/opt",
    "/cores",
    "/dev",
    "/Volumes",
    "/.vol",
    "/.fseventsd",
    "/.Spotlight-V100",
    "/.DocumentRevisions-V100",
    "/.PKInstallSandboxManager-SystemSoftware",
    "/Network",
  ],
};
