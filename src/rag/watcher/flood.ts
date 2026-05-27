// F01 B12 — Flood detection.
//
// A debounce batch with more than `threshold` distinct paths is treated as a
// flood: the runtime logs the top-3 directories by event count and DROPS the
// batch. Per the addendum §3.2.7, the next non-flood batch proceeds normally.

import path from "node:path";

export const DEFAULT_FLOOD_THRESHOLD = 5000;

export interface FloodReport {
  pathCount: number;
  topDirs: Array<{ dir: string; count: number }>;
}

export function detectFlood(
  paths: ReadonlyArray<string>,
  threshold: number = DEFAULT_FLOOD_THRESHOLD,
): FloodReport | null {
  if (paths.length <= threshold) return null;
  const counts = new Map<string, number>();
  for (const p of paths) {
    const dir = path.dirname(p);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const topDirs = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([dir, count]) => ({ dir, count }));
  return { pathCount: paths.length, topDirs };
}
