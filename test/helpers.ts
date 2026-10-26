import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Creates a fake $HOME inside the repo (not under /var/folders, which the guard
 * correctly treats as an OS location) and points disksweep at it.
 */
export function makeFakeHome(name: string): string {
  const home = path.join(here, ".tmp", `${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(home, { recursive: true });
  process.env.DISKSWEEP_USER_HOME = home;
  process.env.DISKSWEEP_DATA_DIR = path.join(home, ".disksweep");
  return home;
}

export function removeFakeHome(home: string): void {
  fs.rmSync(home, { recursive: true, force: true });
}

/** Write a file of `bytes` size (non-sparse so du sees real blocks). */
export function writeFile(file: string, bytes = 1024): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
}
