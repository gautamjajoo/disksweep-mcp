/**
 * The safety guard. Every destructive action passes through `assertSafe`.
 *
 * Design: DEFAULT-DENY. A path may be acted on only if it is inside an allowed
 * zone AND clears every hard block. These rules are code, not configuration:
 * nothing in rule packs, user prefs, proposals or tool arguments can loosen
 * them. Scanning may look anywhere; acting may not.
 */
import fs from "node:fs";
import path from "node:path";
import { getPlatform } from "../platform/index.js";
import { dataDir, fold, isWithin, isWithinFolded, onDiskSpelling, userHome } from "../paths.js";

export type GuardResult = { ok: true } | { ok: false; reason: string };

const deny = (reason: string): GuardResult => ({ ok: false, reason });
const OK: GuardResult = { ok: true };

/** Standard folders under $HOME: the folder itself is never removed (contents may be). */
const HOME_STANDARD_FOLDERS = [
  "Applications",
  "Desktop",
  "Documents",
  "Downloads",
  "Library",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  "Sites",
];

/** Trees under $HOME where nothing may ever be touched (relative to $HOME). */
const HOME_PROTECTED_TREES = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".config",
  ".password-store",
  ".Trash", // handled only by empty_old_trash
  "Library/Keychains",
  "Library/Preferences",
  "Library/Accounts",
  "Library/Mobile Documents", // iCloud Drive
  "Library/CloudStorage", // Dropbox/Google Drive/OneDrive File Provider
  "Library/LaunchAgents",
  "Library/Cookies",
  "Library/Autosave Information",
  "Library/Calendars",
  "Library/Mail",
  "Library/Messages",
  "Library/Safari",
  "Library/Sharing",
  "Library/Passes",
  "Library/PersonalizationPortrait",
  "Library/Suggestions",
  "Library/IdentityServices",
  "Library/Application Support/AddressBook",
  "Library/Application Support/CallHistoryDB",
  "Library/Application Support/Knowledge",
];

/** Narrow exceptions inside otherwise-protected Apple trees. */
const HOME_ALLOWED_EXCEPTIONS = ["Library/Containers/com.apple.mail/Data/Library/Mail Downloads"];

/** Media libraries: may be suggested whole (review), never their insides. */
const LIBRARY_PACKAGE_EXT = [".photoslibrary", ".photolibrary", ".musiclibrary", ".tvlibrary", ".imovielibrary", ".fcpbundle"];

/** `rel` is folded (lower-case). */
function isAppleOwnedLibraryPath(rel: string): boolean {
  const parts = rel.split(path.sep);
  if (parts[0] !== "library" || parts.length < 3) return false;
  const area = parts[1];
  const owner = parts[2];
  if (area === "containers" || area === "application support" || area === "caches" || area === "logs") {
    // Apple's own app data (com.apple.*). Caches/Logs included: some are not regenerated safely.
    return owner.startsWith("com.apple.");
  }
  if (area === "group containers") {
    return owner.startsWith("group.com.apple.") || /\.com\.apple\./.test(owner);
  }
  return false;
}

/**
 * Path check. Paths must be spelled exactly as on disk (APFS ignores case, so
 * "~/library" would otherwise slip past a check for "~/Library"), and every
 * comparison below is case- and normalisation-insensitive as a second layer.
 */
export function checkPath(abs: string): GuardResult {
  if (typeof abs !== "string" || abs.length === 0) return deny("empty path");
  if (abs.includes("\0")) return deny("invalid path");
  if (!path.isAbsolute(abs)) return deny("path must be absolute");
  if (abs.length > 1 && abs.endsWith("/")) return deny("path must not end with '/' (it would follow a symlink)");
  const target = abs;
  if (path.normalize(target) !== target) {
    return deny("path is not normalised (contains '..', '.', or duplicate slashes)");
  }
  const spelled = onDiskSpelling(target);
  if (spelled !== undefined && spelled !== target) {
    return deny(`spelled differently on disk (${spelled}); only the exact on-disk path is accepted`);
  }
  const home = userHome();
  const platform = getPlatform();
  const t = fold(target);
  const h = fold(home);

  if (target === "/") return deny("the root of the disk is never touched");
  if (t.split(path.sep).includes(".git")) return deny("git repository internals are never touched");

  for (const root of platform.systemRoots) {
    if (isWithin(t, fold(root))) return deny(`${root} is an operating-system location`);
  }

  // Allowed zone 2: third-party apps directly in /Applications.
  if (path.dirname(t) === "/applications") {
    if (!t.endsWith(".app")) return deny("only .app bundles in /Applications may be suggested");
    return OK; // Apple-signed apps are rejected by verifyOnDisk.
  }

  // Allowed zone 1: inside $HOME (never $HOME itself).
  if (!isWithin(t, h) || t === h) {
    return deny("outside the allowed zones (your home folder and third-party apps)");
  }
  const rel = path.relative(h, t);
  const parts = rel.split(path.sep);

  if (isWithinFolded(target, dataDir())) return deny("disksweep's own data");

  if (parts.length === 1) {
    if (HOME_STANDARD_FOLDERS.some((f) => fold(f) === parts[0])) return deny(`~/${path.basename(target)} itself is never removed`);
    let isDir = false;
    try {
      isDir = fs.lstatSync(target).isDirectory();
    } catch {
      /* missing: verifyOnDisk will reject */
    }
    if (!isDir) return deny("files directly in your home folder (shell and app settings) are never touched");
  }
  // Direct children of ~/Library (Caches, Logs, Application Support…) are structural.
  if (parts[0] === "library" && parts.length === 2) return deny(`~/Library/${path.basename(target)} itself is never removed`);

  const allowedException = HOME_ALLOWED_EXCEPTIONS.some((ex) => isWithin(rel, fold(ex)) && rel !== fold(ex));
  if (!allowedException) {
    for (const tree of HOME_PROTECTED_TREES) {
      if (isWithin(rel, fold(tree))) return deny(`~/${tree} holds settings, credentials or synced data`);
    }
    if (isAppleOwnedLibraryPath(rel)) return deny("macOS's own app data (com.apple.*)");
  }

  // Media libraries: the package may be suggested as a whole, never its contents.
  for (let i = 0; i < parts.length - 1; i++) {
    if (LIBRARY_PACKAGE_EXT.some((ext) => parts[i].endsWith(ext))) {
      return deny(`inside a media library (${parts[i]}); only the whole library can be reviewed`);
    }
  }
  return OK;
}

/**
 * Filesystem checks performed immediately before acting:
 * no symlinked parents, exists, owned by the user, no SIP/immutable flags,
 * not a mount point, not an Apple-signed app.
 */
export async function verifyOnDisk(abs: string): Promise<GuardResult> {
  const platform = getPlatform();
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(abs);
  } catch {
    return deny("no longer exists");
  }

  // The parent chain must be real and spelled as on disk: blocks
  // ~/innocent-link/... tricks and case-variant spellings of protected folders.
  try {
    const realParent = fs.realpathSync.native(path.dirname(abs));
    if (realParent !== path.dirname(abs)) return deny("a parent folder is a symlink or spelled differently on disk");
  } catch {
    return deny("cannot resolve parent folder");
  }
  if (onDiskSpelling(abs) !== abs) return deny("spelled differently on disk");
  if (abs.length > 1 && abs.endsWith("/")) return deny("path must not end with '/'");

  try {
    const facts = await platform.fileFacts(abs);
    const blocked = facts.flags.filter((f) =>
      ["restricted", "schg", "schange", "simmutable", "sunlnk", "uchg", "uchange", "uimmutable"].includes(f),
    );
    if (blocked.length) return deny(`protected by the OS (${blocked.join(", ")})`);
    if (typeof process.getuid === "function" && facts.uid !== process.getuid()) {
      return deny("owned by another user or the system");
    }
  } catch {
    return deny("could not read file flags");
  }

  try {
    const parentSt = await fs.promises.lstat(path.dirname(abs));
    if (parentSt.dev !== st.dev) return deny("is a mount point / different volume");
  } catch {
    return deny("cannot inspect parent folder");
  }

  if (abs.startsWith("/Applications/") && abs.endsWith(".app")) {
    if (await platform.isOsVendorApp(abs)) return deny("an Apple app that ships with macOS");
  }
  return OK;
}

/** Both checks. Use this before every destructive action. */
export async function assertSafe(abs: string): Promise<GuardResult> {
  const pathCheck = checkPath(abs);
  if (!pathCheck.ok) return pathCheck;
  return verifyOnDisk(abs);
}
