import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { MemoryRecordSchema, SkillRecordSchema, type MemoryRecord } from "./types.js";
import {
  KnowledgeStoreError,
  acquireRecordLock,
  acquireScopeLock,
  acquireTwoRecordLocks,
  appendAuditEntry,
  appendJsonlAtomic,
  assertNoSecrets,
  assertReason,
  assertScopePathCoherence,
  rebuildIndex,
  readAuditLines,
  recordLockKey,
  scopeLockKey,
  unlinkRecordIfExists,
  writeRecordAtomic,
} from "./store.js";

const NOW = "2026-05-23T00:00:00.000Z";
const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const AUTHOR = { role: "manager" as const, agent_id: "agent-1" };

function newTempProject(): string {
  return mkdtempSync(join(tmpdir(), "saivage-knowledge-"));
}

function memoryRecord(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: ID,
    kind: "memory",
    scope: "project",
    status: "active",
    created_at: NOW,
    updated_at: NOW,
    author_agent: AUTHOR,
    topic: { domain: "build", subject: "web-app" },
    body: "Run `npm run build`.",
    keys: [],
    target_agents: [],
    relates_to: [],
    survive_compaction: false,
    ...over,
  };
}

function expectKnowledgeError(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.fail(`expected KnowledgeStoreError with code ${code}, but no error was thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(KnowledgeStoreError);
    expect((err as KnowledgeStoreError).code).toBe(code);
  }
}

const IndexSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(["skill", "memory"]),
  scope: z.enum(["project", "stage", "session"]),
  scope_ref: z.string().optional(),
  status: z.enum(["active", "superseded", "archived", "expired"]),
  updated_at: z.string(),
});
const IndexFileSchema = z.object({ entries: z.array(IndexSummarySchema) });

describe("recordLockKey / scopeLockKey", () => {
  it("produces expected shapes", () => {
    expect(recordLockKey({ kind: "memory", scope: "project", id: "x" })).toBe("memory:project:_:x");
    expect(recordLockKey({ kind: "skill", scope: "stage", scope_ref: "s1", id: "y" })).toBe(
      "skill:stage:s1:y",
    );
    expect(scopeLockKey("memory", "session", "chan1")).toBe("memory:session:chan1");
  });
});

describe("locks serialize concurrent acquisitions", () => {
  it("acquireRecordLock chains in arrival order", async () => {
    const trace: number[] = [];
    const r1 = await acquireRecordLock("k1");
    const p2 = (async () => {
      const r2 = await acquireRecordLock("k1");
      trace.push(2);
      r2();
    })();
    trace.push(1);
    r1();
    await p2;
    expect(trace).toEqual([1, 2]);
  });

  it("acquireTwoRecordLocks uses lex order to avoid deadlock", async () => {
    const releaseAB = await acquireTwoRecordLocks("a", "b");
    const releaseBA = acquireTwoRecordLocks("b", "a"); // would deadlock w/o lex order
    setTimeout(() => releaseAB(), 10);
    const release2 = await releaseBA;
    await release2();
  });

  it("acquireScopeLock is independent of recordLocks", async () => {
    const rs = await acquireScopeLock("k");
    const rr = await acquireRecordLock("k");
    rr();
    rs();
  });
});

describe("assertReason", () => {
  it("accepts non-empty string", () => {
    expect(assertReason("ok")).toBe("ok");
  });
  it("rejects empty / whitespace / non-string", () => {
    expectKnowledgeError(() => assertReason(""), "EMPTY_REASON");
    expectKnowledgeError(() => assertReason("   "), "EMPTY_REASON");
    expect(() => assertReason(undefined)).toThrow();
  });
});

describe("assertScopePathCoherence", () => {
  it("accepts matching paths", () => {
    expect(() =>
      assertScopePathCoherence("/x/.saivage/memory/project", { scope: "project" }),
    ).not.toThrow();
    expect(() =>
      assertScopePathCoherence("/x/.saivage/skills/stages/s1", { scope: "stage", scope_ref: "s1" }),
    ).not.toThrow();
    expect(() =>
      assertScopePathCoherence("/x/.saivage/memory/sessions/c1", {
        scope: "session",
        scope_ref: "c1",
      }),
    ).not.toThrow();
  });

  it("rejects scope=project with non-project path", () => {
    expectKnowledgeError(
      () => assertScopePathCoherence("/x/memory/stages/s1", { scope: "project" }),
      "INVALID_SCOPE_REF",
    );
  });

  it("rejects stage without scope_ref", () => {
    expectKnowledgeError(
      () => assertScopePathCoherence("/x/memory/stages/s1", { scope: "stage" }),
      "INVALID_SCOPE_REF",
    );
  });

  it("rejects mismatched scope_ref", () => {
    expectKnowledgeError(
      () =>
        assertScopePathCoherence("/x/memory/stages/other", {
          scope: "stage",
          scope_ref: "s1",
        }),
      "INVALID_SCOPE_REF",
    );
  });
});

describe("assertNoSecrets", () => {
  it("passes clean fields", () => {
    expect(() =>
      assertNoSecrets({ body: "ordinary memory body without keys" }),
    ).not.toThrow();
  });

  it("rejects fields with secret-shaped content", () => {
    expectKnowledgeError(
      () => assertNoSecrets({ body: "use sk-" + "x".repeat(40) }),
      "SECRET_DETECTED",
    );
  });
});

describe("writeRecordAtomic", () => {
  it("writes a record file under <dir>/records/<id>.json", () => {
    const root = newTempProject();
    const dir = join(root, ".saivage", "memory", "project");
    const r = memoryRecord();
    writeRecordAtomic(dir, r.id, MemoryRecordSchema, r);
    const file = join(dir, "records", `${r.id}.json`);
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    expect(parsed.id).toBe(r.id);
  });

  it("rejects INVALID_SCOPE_REF when path disagrees with scope", () => {
    const root = newTempProject();
    const dir = join(root, ".saivage", "memory", "stages", "s1");
    const r = memoryRecord({ scope: "project" }); // mismatched
    expectKnowledgeError(
      () => writeRecordAtomic(dir, r.id, MemoryRecordSchema, r),
      "INVALID_SCOPE_REF",
    );
    expect(existsSync(join(dir, "records", `${r.id}.json`))).toBe(false);
  });

  it("rejects SECRET_DETECTED before writing", () => {
    const root = newTempProject();
    const dir = join(root, ".saivage", "memory", "project");
    const r = memoryRecord({ body: "key sk-" + "a".repeat(40) });
    expectKnowledgeError(
      () => writeRecordAtomic(dir, r.id, MemoryRecordSchema, r),
      "SECRET_DETECTED",
    );
    expect(existsSync(join(dir, "records", `${r.id}.json`))).toBe(false);
  });

  it("scans skill description for secrets", () => {
    const root = newTempProject();
    const dir = join(root, ".saivage", "skills", "project");
    expectKnowledgeError(
      () =>
        writeRecordAtomic(dir, ID, SkillRecordSchema, {
        id: ID,
        kind: "skill",
        scope: "project",
        status: "active",
        created_at: NOW,
        updated_at: NOW,
        author_agent: AUTHOR,
        name: "deploy",
        description: "deploy with token ghp_" + "z".repeat(36),
        body_path: "records/x.md",
        triggers: [],
        target_agents: [],
        relates_to: [],
        survive_compaction: false,
        origin: "project",
      }),
      "SECRET_DETECTED",
    );
  });

  it("unlinkRecordIfExists removes record JSON", () => {
    const root = newTempProject();
    const dir = join(root, ".saivage", "memory", "project");
    const r = memoryRecord();
    writeRecordAtomic(dir, r.id, MemoryRecordSchema, r);
    unlinkRecordIfExists(dir, r.id);
    expect(existsSync(join(dir, "records", `${r.id}.json`))).toBe(false);
    // idempotent
    expect(() => unlinkRecordIfExists(dir, r.id)).not.toThrow();
  });
});

describe("appendJsonlAtomic / readAuditLines", () => {
  it("appends one line per call", () => {
    const root = newTempProject();
    const path = join(root, ".saivage", "memory", "project", "audit.jsonl");
    appendAuditEntry(path, {
      ts: NOW,
      record_id: ID,
      op: "create",
      outcome: "ok",
      author_agent: AUTHOR,
      reason: "first",
    });
    appendAuditEntry(path, {
      ts: NOW,
      record_id: ID,
      op: "update",
      outcome: "ok",
      author_agent: AUTHOR,
      reason: "second",
    });
    const lines = readAuditLines(path);
    expect(lines.length).toBe(2);
    expect(lines.every((l) => l.ok)).toBe(true);
  });

  it("truncates lines > 2048 B with …[truncated] suffix", () => {
    const root = newTempProject();
    const path = join(root, ".saivage", "memory", "project", "audit.jsonl");
    const big = "x".repeat(4096);
    appendAuditEntry(path, {
      ts: NOW,
      record_id: ID,
      op: "update",
      author_agent: AUTHOR,
      reason: big,
    });
    const raw = readFileSync(path, "utf-8").trimEnd();
    expect(raw.length).toBeLessThanOrEqual(2048);
    expect(raw).toMatch(/…\[truncated\]/);
  });

  it("tolerates truncated trailing line", () => {
    const root = newTempProject();
    const dir = join(root, ".saivage", "memory", "project");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "audit.jsonl");
    appendAuditEntry(path, {
      ts: NOW,
      record_id: ID,
      op: "create",
      author_agent: AUTHOR,
      reason: "first",
    });
    // simulate a torn last line
    writeFileSync(path, readFileSync(path, "utf-8") + '{"partial":', "utf-8");
    const lines = readAuditLines(path);
    expect(lines.length).toBe(1);
    expect(lines[0].ok).toBe(true);
  });

  it("reports MALFORMED_AUDIT_LINE markers for mid-file garbage", () => {
    const root = newTempProject();
    const dir = join(root, ".saivage", "memory", "project");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "audit.jsonl");
    appendAuditEntry(path, {
      ts: NOW,
      record_id: ID,
      op: "create",
      author_agent: AUTHOR,
      reason: "first",
    });
    writeFileSync(path, readFileSync(path, "utf-8") + "not-json\n", "utf-8");
    appendAuditEntry(path, {
      ts: NOW,
      record_id: ID,
      op: "update",
      author_agent: AUTHOR,
      reason: "after-garbage",
    });
    const lines = readAuditLines(path);
    expect(lines.length).toBe(3);
    expect(lines[1].ok).toBe(false);
  });
});

describe("rebuildIndex", () => {
  it("projects records to summaries, sorted by id", () => {
    const root = newTempProject();
    const dir = join(root, ".saivage", "memory", "project");
    const r1 = memoryRecord({ id: ID2 });
    const r2 = memoryRecord({ id: ID });
    writeRecordAtomic(dir, r1.id, MemoryRecordSchema, r1);
    writeRecordAtomic(dir, r2.id, MemoryRecordSchema, r2);
    const idx = rebuildIndex(dir, MemoryRecordSchema, IndexFileSchema);
    expect(idx.entries.map((e) => e.id)).toEqual([ID, ID2]);
    expect(idx.entries[0]).toMatchObject({ kind: "memory", scope: "project", status: "active" });
    expect(existsSync(join(dir, "index.json"))).toBe(true);
  });

  it("is idempotent (running twice yields equal output)", () => {
    const root = newTempProject();
    const dir = join(root, ".saivage", "memory", "project");
    writeRecordAtomic(dir, ID, MemoryRecordSchema, memoryRecord());
    const a = rebuildIndex(dir, MemoryRecordSchema, IndexFileSchema);
    const b = rebuildIndex(dir, MemoryRecordSchema, IndexFileSchema);
    expect(a).toEqual(b);
  });

  it("skips malformed record files instead of crashing", () => {
    const root = newTempProject();
    const dir = join(root, ".saivage", "memory", "project");
    writeRecordAtomic(dir, ID, MemoryRecordSchema, memoryRecord());
    writeFileSync(join(dir, "records", `${ID2}.json`), "not json", "utf-8");
    const idx = rebuildIndex(dir, MemoryRecordSchema, IndexFileSchema);
    expect(idx.entries.map((e) => e.id)).toEqual([ID]);
  });
});
