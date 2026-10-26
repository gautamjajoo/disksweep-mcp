import { darwin } from "./darwin.js";

export interface DiskInfo {
  mount: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  percentUsed: number;
}

export interface VolumeUsage {
  name: string;
  role: string;
  bytes: number;
}

export interface FileFacts {
  /** BSD flags, e.g. ["restricted", "uchg"]. */
  flags: string[];
  uid: number;
}

/**
 * Everything OS-specific lives behind this interface so Windows/Linux can be
 * added without touching scanning, detection or safety logic.
 */
export interface Platform {
  name: string;
  diskInfo(path: string): Promise<DiskInfo>;
  /** Move to the OS trash so the user can restore it. */
  moveToTrash(paths: string[]): Promise<void>;
  /** When the user last opened the item, if the OS tracks it. */
  lastUsed(path: string): Promise<Date | undefined>;
  /** When the item was added to its folder (e.g. download / trash time). */
  dateAdded(path: string): Promise<Date | undefined>;
  fileFacts(path: string): Promise<FileFacts>;
  /** True if an Apple/OS-vendor signed application bundle. */
  isOsVendorApp(appPath: string): Promise<boolean>;
  isProcessRunning(name: string): Promise<boolean>;
  trashDir(): string;
  /** Space used by each volume sharing the disk (system, swap, recovery…), if known. */
  volumes(): Promise<VolumeUsage[]>;
  /** Roots that must never be acted on, in addition to the shared guard. */
  systemRoots: string[];
}

export function getPlatform(): Platform {
  if (process.platform === "darwin") return darwin;
  throw new Error(
    `disksweep currently supports macOS only (running on ${process.platform}). Windows and Linux support is planned.`,
  );
}
