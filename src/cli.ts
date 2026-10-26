/** `disksweep-mcp report`: read-only, for routines the user sets up themselves. Never deletes. */
import { getPlatform } from "./platform/index.js";
import { formatBytes } from "./format.js";
import { startScan } from "./scan/scanner.js";
import { analyse, formatAnalysis } from "./analyse.js";

export async function report(): Promise<string> {
  const d = await getPlatform().diskInfo("/");
  const job = startScan("incremental");
  const idx = await job.promise;
  const a = await analyse(idx);
  return [
    `Disk ${d.percentUsed}% full — ${formatBytes(d.freeBytes)} free of ${formatBytes(d.totalBytes)}.`,
    `Scan: ${job.mode}, ${Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000)}s.`,
    "",
    formatAnalysis(a, { limit: 15 }),
    "",
    "Nothing was deleted. Ask your assistant to run the disksweep disk_checkup to clean up.",
  ].join("\n");
}
