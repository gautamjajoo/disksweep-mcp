import { dataPath, readJson } from "./paths.js";

export interface Config {
  /** Folder/volume to scan. Default: the whole macOS data volume. */
  scanRoot?: string;
  /** Folders and files at least this big are kept in the index (default 10 MB). */
  minNodeBytes: number;
  /** Project build folders untouched this long are suggested (default 30 days). */
  staleProjectDays: number;
  /** Downloads/Desktop items not opened this long are suggested (default 60 days). */
  staleDownloadDays: number;
  /** Apps not opened this long are suggested (default 90 days). */
  unusedAppDays: number;
  /** Extra paths the user never wants touched (in addition to the built-in guard). */
  protected: string[];
}

const DEFAULTS: Config = {
  minNodeBytes: 10 * 1000 * 1000,
  staleProjectDays: 30,
  staleDownloadDays: 60,
  unusedAppDays: 90,
  protected: [],
};

export function loadConfig(): Config {
  return { ...DEFAULTS, ...readJson<Partial<Config>>(dataPath("config.json"), {}) };
}
