import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openSidecar, sidecarExists } from "./sidecar.js";
import {
  getRecord,
  activeRecordsByScope,
  listActiveItems,
  loadAllActiveRowsForEager,
  pendingReingestKinds,
  clearPendingReingest,
  recordCount,
} from "./sidecar-queries.js";

describe("knowledge sidecar", () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), "sidecar-"));
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it("creates the database file and applies v1 schema", async () => {
    const s = await openSidecar(projectRoot);
    expect(sidecarExists(projectRoot)).toBe(true);
    expect(s.db.pragma("user_version", { simple: true })).toBe(1);
    for (const t of ["record", "record_skill", "record_memory", "audit", "rag_sync"]) {
      const exists = s.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(t);
      expect(exists, `table ${t} should exist`).toBeDefined();
    }
    s.close();
  });

  it("re-opening is idempotent", async () => {
    const s1 = await openSidecar(projectRoot);
    s1.close();
    const s2 = await openSidecar(projectRoot);
    expect(s2.db.pragma("user_version", { simple: true })).toBe(1);
    s2.close();
  });

  it("inTransaction rolls back on throw", async () => {
    const s = await openSidecar(projectRoot);
    expect(() =>
      s.inTransaction(() => {
        s.db.prepare(
          "INSERT INTO record (id, kind, scope, status, origin, record_json, body, created_at, updated_at) VALUES ('x','skill','project','active','project','{}','b','t','t')",
        ).run();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(recordCount(s)).toBe(0);
    s.close();
  });

  it("CRUD + queries round-trip", async () => {
    const s = await openSidecar(projectRoot);
    s.db.prepare(
      "INSERT INTO record (id, kind, scope, scope_ref, status, origin, record_json, body, created_at, updated_at, pending_reingest) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run("a", "skill", "project", null, "active", "project", "{}", "body-a", "t0", "t0", 0);
    s.db.prepare("INSERT INTO record_skill (id, name) VALUES ('a','alpha')").run();

    expect(getRecord(s, "a")?.id).toBe("a");
    expect(activeRecordsByScope(s, "skill", "project").length).toBe(1);
    expect(activeRecordsByScope(s, "skill", "project", "ref").length).toBe(0);

    const items = listActiveItems(s, "skill");
    expect(items[0]?.metadata.path).toBe("skill:a.md");
    expect(items[0]?.metadata.source).toBe("skill");

    expect(loadAllActiveRowsForEager(s)[0]?.body).toBe("body-a");
    s.close();
  });

  it("pending_reingest enumeration + clear", async () => {
    const s = await openSidecar(projectRoot);
    s.db.prepare(
      "INSERT INTO record (id, kind, scope, status, origin, record_json, body, created_at, updated_at, pending_reingest) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("m1", "memory", "project", "active", "project", "{}", "b", "t", "t", 1);

    expect(pendingReingestKinds(s)).toEqual(["memory"]);
    clearPendingReingest(s, "memory");
    expect(pendingReingestKinds(s)).toEqual([]);
    s.close();
  });
});
