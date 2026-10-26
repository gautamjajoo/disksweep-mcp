/**
 * Regenerable folders inside code projects (node_modules, virtualenvs, build
 * output) for projects that haven't been touched in a while. Found via the
 * size index, so it costs nothing extra; the project folder itself is never
 * suggested.
 */
import fs from "node:fs";
import path from "node:path";
import { userHome } from "../paths.js";
import { ScanIndex, walkTree } from "../scan/tree.js";
import { Candidate, candidateId } from "./types.js";

interface ArtifactKind {
  dir: string;
  /** Files that prove this is a project of the right kind (in the parent folder). */
  markers: string[];
  /** Or: a file that must exist inside the artifact folder. */
  inner?: string;
  label: string;
  regenerates: string;
}

const KINDS: ArtifactKind[] = [
  { dir: "node_modules", markers: ["package.json"], label: "Node.js dependencies", regenerates: "`npm install` (or pnpm/yarn/bun install) recreates it." },
  { dir: ".next", markers: ["package.json"], label: "Next.js build cache", regenerates: "Rebuilt on the next `next build` / `next dev`." },
  { dir: ".nuxt", markers: ["package.json"], label: "Nuxt build cache", regenerates: "Rebuilt on the next build." },
  { dir: ".turbo", markers: ["package.json"], label: "Turborepo cache", regenerates: "Rebuilt on the next build." },
  { dir: ".venv", markers: [], inner: "pyvenv.cfg", label: "Python virtual environment", regenerates: "Recreate with `python -m venv .venv` and reinstall requirements (or `uv sync`)." },
  { dir: "venv", markers: [], inner: "pyvenv.cfg", label: "Python virtual environment", regenerates: "Recreate with `python -m venv venv` and reinstall requirements." },
  { dir: "target", markers: ["Cargo.toml"], label: "Rust build output", regenerates: "`cargo build` recreates it." },
  { dir: "target", markers: ["pom.xml"], label: "Maven build output", regenerates: "`mvn package` recreates it." },
  { dir: "build", markers: ["build.gradle", "build.gradle.kts"], label: "Gradle build output", regenerates: "`gradle build` recreates it." },
  { dir: ".gradle", markers: ["build.gradle", "build.gradle.kts", "settings.gradle"], label: "Gradle project cache", regenerates: "Recreated on the next Gradle run." },
  { dir: "Pods", markers: ["Podfile"], label: "CocoaPods dependencies", regenerates: "`pod install` recreates it." },
  { dir: ".terraform", markers: [], label: "Terraform providers", regenerates: "`terraform init` re-downloads them." },
];

/**
 * When the project was last worked on: newest change among its own top-level
 * entries (excluding the artifact) and its git index.
 */
async function projectLastTouched(projectDir: string, exclude: string): Promise<number> {
  let latest = 0;
  let names: string[] = [];
  try {
    latest = (await fs.promises.stat(projectDir)).mtimeMs;
    names = await fs.promises.readdir(projectDir);
  } catch {
    return latest;
  }
  for (const name of names) {
    if (name === exclude) continue;
    const p = name === ".git" ? path.join(projectDir, ".git", "index") : path.join(projectDir, name);
    try {
      latest = Math.max(latest, (await fs.promises.lstat(p)).mtimeMs);
    } catch {
      /* ignore */
    }
  }
  return latest;
}

/**
 * Only real projects the user works on: not app bundles, not ~/Library, not tool
 * installs under ~/.something (editor extensions, nvm, …) whose dependencies
 * `npm install` could not recreate.
 */
function inUserProjectArea(dir: string): boolean {
  const home = userHome();
  if (!dir.startsWith(home + "/")) return false;
  const rel = dir.slice(home.length + 1).split("/");
  if (rel[0] === "Library" || rel[0].startsWith(".")) return false;
  return !rel.some((seg) => seg.endsWith(".app") || seg === "extensions");
}

function matchKind(dir: string, name: string): ArtifactKind | undefined {
  if (!inUserProjectArea(dir)) return undefined;
  // Nested dependency folders are covered by their outermost artifact.
  if (dir.split(path.sep).filter((s) => s === "node_modules").length > 1) return undefined;
  for (const k of KINDS) {
    if (k.dir !== name) continue;
    if (k.inner && !fs.existsSync(path.join(dir, k.inner))) continue;
    if (k.markers.length && !k.markers.some((m) => fs.existsSync(path.join(path.dirname(dir), m)))) continue;
    return k;
  }
  return undefined;
}

export async function findProjectArtifacts(index: ScanIndex, staleDays: number, minBytes: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const found: string[] = [];
  for (const { node } of walkTree(index.tree)) {
    if (node.isFile || node.size < minBytes) continue;
    const name = path.basename(node.path);
    const kind = matchKind(node.path, name);
    if (!kind) continue;
    if (found.some((f) => node.path.startsWith(f + "/"))) continue;
    const project = path.dirname(node.path);
    const touched = await projectLastTouched(project, name);
    const idleDays = Math.floor((Date.now() - touched) / 86_400_000);
    if (idleDays < staleDays) continue;
    found.push(node.path);
    out.push({
      id: candidateId("project-artifact", [node.path]),
      title: `${kind.label} in ${path.basename(project)}`,
      detector: "project-artifact",
      category: "dev",
      tier: "rebuildable",
      paths: [node.path],
      size: node.size,
      reason: `The project "${path.basename(project)}" hasn't been changed in ${idleDays} days. Only this regenerable folder would be removed; your code stays.`,
      regenerates: kind.regenerates,
      lastUsed: touched || undefined,
    });
  }
  return out;
}
