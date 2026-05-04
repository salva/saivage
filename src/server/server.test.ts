import { describe, it, expect, afterEach } from "vitest";
import { isPathInside } from "./server.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

describe("isPathInside", () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length > 0) {
      const path = created.pop();
      if (path) rmSync(path, { recursive: true, force: true });
    }
  });

  it("treats the base directory itself as inside", () => {
    const base = mkdtempSync(join(tmpdir(), "saivage-pathcheck-"));
    created.push(base);
    expect(isPathInside(base, base)).toBe(true);
  });

  it("accepts proper descendants", () => {
    const base = mkdtempSync(join(tmpdir(), "saivage-pathcheck-"));
    created.push(base);
    expect(isPathInside(base, join(base, "a"))).toBe(true);
    expect(isPathInside(base, join(base, "a", "b", "c.txt"))).toBe(true);
  });

  it("rejects sibling paths whose name shares a prefix", () => {
    const base = mkdtempSync(join(tmpdir(), "saivage-pathcheck-"));
    created.push(base);
    // Sibling that startsWith() would falsely accept.
    expect(isPathInside(base, `${base}x`)).toBe(false);
    expect(isPathInside(base, `${base}-attack/file`)).toBe(false);
  });

  it("rejects parent traversal", () => {
    const base = mkdtempSync(join(tmpdir(), "saivage-pathcheck-"));
    created.push(base);
    expect(isPathInside(base, join(base, ".."))).toBe(false);
    expect(isPathInside(base, join(base, "..", "etc", "passwd"))).toBe(false);
  });
});
