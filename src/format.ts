const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 1536 -> "1.5 KB" (decimal units, matching Finder and OmniDiskSweeper). */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 || Math.abs(value) >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function daysAgo(date: Date | number | undefined): number | undefined {
  if (date === undefined) return undefined;
  const ms = typeof date === "number" ? date : date.getTime();
  return Math.floor((Date.now() - ms) / 86_400_000);
}

export function describeAge(date: Date | number | undefined): string {
  const days = daysAgo(date);
  if (days === undefined) return "unknown";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}
