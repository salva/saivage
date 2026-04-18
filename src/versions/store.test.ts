import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { snapshot, listVersions, getVersion, rollback, prune, type VersionEntry } from "./store.js";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("version store", () => {
  let testDir: string;
  let sourceDir: string;
  const originalHome = process.env["HOME"];

  beforeEach(() => {
    testDir = join(tmpdir(), `saivage-ver-test-${randomUUID()}`);
    sourceDir = join(testDir, "source");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "index.ts"), 'console.log("v1");');

    // Override HOME so saivageDir() goes to our test dir
    process.env["HOME"] = testDir;
  });

  afterEach(() => {
    process.env["HOME"] = originalHome;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates a snapshot", () => {
    const entry = snapshot({ name: "test-svc", version: "1.0.0", sourcePath: sourceDir });
    expect(entry.name).toBe("test-svc");
    expect(existsSync(entry.snapshotPath)).toBe(true);
    expect(readFileSync(join(entry.snapshotPath, "index.ts"), "utf-8")).toBe('console.log("v1");');
  });

  it("lists versions by name", () => {
    snapshot({ name: "svc-a", version: "1.0.0", sourcePath: sourceDir });
    snapshot({ name: "svc-b", version: "1.0.0", sourcePath: sourceDir });
    snapshot({ name: "svc-a", version: "2.0.0", sourcePath: sourceDir });

    expect(listVersions("svc-a")).toHaveLength(2);
    expect(listVersions("svc-b")).toHaveLength(1);
    expect(listVersions()).toHaveLength(3);
  });

  it("rolls back to a snapshot", () => {
    const entry = snapshot({ name: "test-svc", version: "1.0.0", sourcePath: sourceDir });

    // Modify source
    writeFileSync(join(sourceDir, "index.ts"), 'console.log("v2");');
    expect(readFileSync(join(sourceDir, "index.ts"), "utf-8")).toBe('console.log("v2");');

    // Rollback
    const ok = rollback(entry.id);
    expect(ok).toBe(true);
    expect(readFileSync(join(sourceDir, "index.ts"), "utf-8")).toBe('console.log("v1");');
  });

  it("prunes old versions", () => {
    for (let i = 0; i < 8; i++) {
      snapshot({ name: "test-svc", version: `${i}.0.0`, sourcePath: sourceDir });
    }
    expect(listVersions("test-svc")).toHaveLength(8);

    const removed = prune(3);
    expect(removed).toBe(5);
    expect(listVersions("test-svc")).toHaveLength(3);
  });
});
