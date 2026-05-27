import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { walk } from "./walker.js";

async function collect(it: AsyncIterable<{ relPath: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const f of it) out.push(f.relPath);
  return out.sort();
}

describe("walker", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rag-walk-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits files matching include globs", async () => {
    writeFileSync(path.join(dir, "a.md"), "hi");
    writeFileSync(path.join(dir, "b.ts"), "x");
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "sub", "c.md"), "hi");
    const got = await collect(walk({ root: dir, include: ["**/*.md"] }));
    expect(got).toEqual(["a.md", "sub/c.md"]);
  });

  it("hard-excludes .git, node_modules, .saivage", async () => {
    for (const d of [".git", "node_modules", ".saivage"]) {
      mkdirSync(path.join(dir, d));
      writeFileSync(path.join(dir, d, "x.md"), "x");
    }
    writeFileSync(path.join(dir, "ok.md"), "ok");
    const got = await collect(walk({ root: dir, include: ["**/*.md"] }));
    expect(got).toEqual(["ok.md"]);
  });

  it("applies user excludes", async () => {
    writeFileSync(path.join(dir, "keep.md"), "x");
    mkdirSync(path.join(dir, "build"));
    writeFileSync(path.join(dir, "build", "drop.md"), "x");
    const got = await collect(walk({ root: dir, include: ["**/*.md"], exclude: ["**/build/**"] }));
    expect(got).toEqual(["keep.md"]);
  });

  it("skips secret-bearing paths", async () => {
    mkdirSync(path.join(dir, "secrets"));
    writeFileSync(path.join(dir, "secrets", "token.txt"), "sk-...");
    writeFileSync(path.join(dir, "ok.txt"), "ok");
    const got = await collect(walk({ root: dir, include: ["**/*.txt"] }));
    expect(got).toEqual(["ok.txt"]);
  });

  it("does not loop on symlink cycles", async () => {
    writeFileSync(path.join(dir, "a.md"), "x");
    mkdirSync(path.join(dir, "sub"));
    try {
      symlinkSync(dir, path.join(dir, "sub", "loop"));
    } catch {
      return; // skip on systems without symlink support
    }
    const got = await collect(walk({ root: dir, include: ["**/*.md"] }));
    expect(got).toEqual(["a.md"]);
  });

  it("silently skips symlinks that escape the root", async () => {
    // Create an outside directory with a file and a symlink into it.
    const outside = mkdtempSync(path.join(tmpdir(), "rag-walk-out-"));
    try {
      writeFileSync(path.join(outside, "leak.md"), "secret");
      writeFileSync(path.join(dir, "ok.md"), "ok");
      try {
        symlinkSync(outside, path.join(dir, "out"));
      } catch {
        return;
      }
      const got = await collect(walk({ root: dir, include: ["**/*.md"] }));
      expect(got).toEqual(["ok.md"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("follows symlinks that point to siblings inside the root", async () => {
    writeFileSync(path.join(dir, "real.md"), "x");
    try {
      symlinkSync(path.join(dir, "real.md"), path.join(dir, "alias.md"));
    } catch {
      return;
    }
    const got = await collect(walk({ root: dir, include: ["**/*.md"] }));
    expect(got).toEqual(["alias.md", "real.md"]);
  });
});
