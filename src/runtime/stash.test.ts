import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stashResult, readStash, cleanStash } from "./stash.js";

describe("runtime/stash", () => {
  let projectRoot: string;
  let stashRoot: string;
  let previousProjectRoot: string | undefined;
  let previousSaivageRoot: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "saivage-stash-"));
    previousProjectRoot = process.env["PROJECT_ROOT"];
    previousSaivageRoot = process.env["SAIVAGE_ROOT"];
    process.env["PROJECT_ROOT"] = projectRoot;
    process.env["SAIVAGE_ROOT"] = join(projectRoot, ".saivage");
    mkdirSync(join(projectRoot, ".saivage"), { recursive: true });
    stashRoot = join(projectRoot, ".saivage", "tmp", "stash");
  });

  afterEach(() => {
    if (previousProjectRoot === undefined) delete process.env["PROJECT_ROOT"];
    else process.env["PROJECT_ROOT"] = previousProjectRoot;
    if (previousSaivageRoot === undefined) delete process.env["SAIVAGE_ROOT"];
    else process.env["SAIVAGE_ROOT"] = previousSaivageRoot;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("round-trips a small payload through stashResult + readStash", async () => {
    const path = await stashResult("hello world", "tool_T1");
    expect(path.startsWith(stashRoot)).toBe(true);
    const r = await readStash(path);
    expect(r.content).toBe("hello world");
    expect(r.totalSize).toBe(11);
  });

  it("slices via offset/length", async () => {
    const content = "x".repeat(1024);
    const path = await stashResult(content, "tool_T2");
    expect(path.startsWith(stashRoot)).toBe(true);
    const r = await readStash(path, 100, 50);
    expect(r.content.length).toBe(50);
    expect(r.offset).toBe(100);
    expect(r.length).toBe(50);
    expect(r.totalSize).toBe(1024);
  });

  it("rejects paths outside the stash root", async () => {
    await expect(readStash("/etc/passwd")).rejects.toThrow(/read_stash only works on stashed files under/);
  });

  it("cleanStash removes only files older than maxAgeMs", async () => {
    const a = await stashResult("a", "tool_T3");
    const b = await stashResult("b", "tool_T3");
    const c = await stashResult("c", "tool_T3");
    expect(a.startsWith(stashRoot)).toBe(true);
    const past = new Date(Date.now() - 10 * 60_000);
    await utimes(a, past, past);
    await utimes(b, past, past);
    const removed = await cleanStash(60_000);
    expect(removed).toBe(2);
    const remaining = await readStash(c);
    expect(remaining.content).toBe("c");
  });
});
