import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** The user's home directory. Overridable for tests via DISKSWEEP_USER_HOME. */
export function userHome(): string {
  return process.env.DISKSWEEP_USER_HOME ?? os.homedir();
}

/** Where disksweep keeps its index, snapshots, proposals and history. */
export function dataDir(): string {
  const dir = process.env.DISKSWEEP_DATA_DIR ?? path.join(userHome(), ".disksweep");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function dataPath(...parts: string[]): string {
  const p = path.join(dataDir(), ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

/** Expand a leading ~ and normalise. Does not touch the filesystem. */
export function expandHome(p: string): string {
  if (p === "~") return userHome();
  if (p.startsWith("~/")) return path.join(userHome(), p.slice(2));
  return path.resolve(p);
}

/** Show paths under home as ~/… for readability. */
export function tildify(p: string): string {
  const home = userHome();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}

/** True if `child` is `parent` or inside it. */
export function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Atomic JSON write (write temp file then rename). */
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
