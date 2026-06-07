import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stashResult, cleanStash } from "./stash.js";

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

  it("returns a project-relative stash path readable by filesystem read", async () => {
    const path = await stashResult("hello world", "tool_T1");
    expect(path.startsWith(".saivage/tmp/stash/")).toBe(true);
    expect(readFileSync(join(projectRoot, path), "utf-8")).toBe("hello world");
  });

  it("writes stash files under the project-local stash directory", async () => {
    const content = "x".repeat(1024);
    const path = await stashResult(content, "tool_T2");
    expect(path.startsWith(".saivage/tmp/stash/")).toBe(true);
    expect(join(projectRoot, path).startsWith(stashRoot)).toBe(true);
    expect(existsSync(join(projectRoot, path))).toBe(true);
  });

  it("cleanStash removes only files older than maxAgeMs", async () => {
    const a = await stashResult("a", "tool_T3");
    const b = await stashResult("b", "tool_T3");
    const c = await stashResult("c", "tool_T3");
    expect(a.startsWith(".saivage/tmp/stash/")).toBe(true);
    const past = new Date(Date.now() - 10 * 60_000);
    await utimes(join(projectRoot, a), past, past);
    await utimes(join(projectRoot, b), past, past);
    const removed = await cleanStash(60_000);
    expect(removed).toBe(2);
    expect(readFileSync(join(projectRoot, c), "utf-8")).toBe("c");
  });
});
