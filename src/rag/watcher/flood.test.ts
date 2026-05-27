// F01 B12 — Flood detection tests.

import { describe, it, expect } from "vitest";
import { detectFlood } from "./flood.js";

describe("detectFlood", () => {
  it("returns null below threshold", () => {
    expect(detectFlood(["/a/x", "/a/y"], 10)).toBeNull();
  });

  it("reports top-3 directories above threshold", () => {
    const paths = [
      ...Array.from({ length: 6 }, (_, i) => `/repo/a/f${i}`),
      ...Array.from({ length: 4 }, (_, i) => `/repo/b/f${i}`),
      ...Array.from({ length: 2 }, (_, i) => `/repo/c/f${i}`),
      "/repo/d/f0",
    ];
    const r = detectFlood(paths, 5);
    expect(r).not.toBeNull();
    if (!r) throw new Error("unreachable");
    expect(r.pathCount).toBe(13);
    expect(r.topDirs).toHaveLength(3);
    expect(r.topDirs[0]).toEqual({ dir: "/repo/a", count: 6 });
    expect(r.topDirs[1]).toEqual({ dir: "/repo/b", count: 4 });
  });
});
