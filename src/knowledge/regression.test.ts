/**
 * Saivage — knowledge regression pins (M5 / WI-21, F01 B04 sidecar variant).
 *
 * Lightweight regression tests anchored to FR-31* sub-clauses that aren't
 * already covered by the in-place M1/M2/M3 unit suites. After F01 B04
 * the on-disk JSON tree is gone — these tests now poke at the sidecar
 * directly instead of `records/*.json` and `audit.jsonl`.
 *
 * Tests intentionally NOT duplicated here:
 *  • fr31a (bundled built-in skills load) — eagerLoader.test.ts.
 *  • fr31b (triggerless skill round-trip) — knowledgeSkills.test.ts.
 *  • fr31e(i) (Designer/Chat skill-write denial) — integration.test.ts.
 *  • fr31f (write-side secret rejection) — knowledgeSkills.test.ts.
 *  • fr31g (concurrent writes) — concurrency.test.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initProjectTree } from "../store/project.js";
import {
  createSkill,
  createMemory,
  updateSkill,
  updateMemory,
  getMemory,
  type AuthorAgent,
} from "./lifecycle.js";
import { redactForRead } from "./loader.js";
import { knowledgeSkillsTools } from "../mcp/knowledgeSkills.js";
import { knowledgeMemoryTools } from "../mcp/knowledgeMemory.js";
import { acquireRuntimeLock, type RuntimeLock } from "../runtime/recovery.js";
import { makeTestStore } from "./_testfixtures/store.js";
import type { KnowledgeStore } from "./init.js";
import { getRecord } from "./sidecar-queries.js";

const AUTHOR: AuthorAgent = { role: "manager", agent_id: "m1" };

let projectRoot: string;
let saivage: string;
let runtimeLock: RuntimeLock | null;
let store: KnowledgeStore;

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), "saivage-regress-"));
  await initProjectTree(projectRoot);
  saivage = join(projectRoot, ".saivage");
  runtimeLock = await acquireRuntimeLock(saivage);
  store = await makeTestStore(projectRoot);
});
afterEach(() => {
  store?.sidecar.close();
  runtimeLock?.release();
  runtimeLock = null;
  rmSync(projectRoot, { recursive: true, force: true });
});

// ─── FR-31c — update refreshes updated_at + audit ─────────────────────────

describe("FR-31c — update refreshes updated_at + audit", () => {
  it("updateSkill bumps updated_at strictly later and appends an update audit row", async () => {
    const s = await createSkill(
      store,
      { name: "u1", description: "d", body: "v1", scope: "project", reason: "init" },
      AUTHOR,
    );
    const before = getRecord(store.sidecar, s.id);
    expect(before).not.toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    const u = await updateSkill(store, { id: s.id, description: "d2", reason: "doc" }, AUTHOR);
    expect(new Date(u.updated_at).getTime()).toBeGreaterThan(
      new Date(before?.created_at ?? 0).getTime(),
    );
    const after = getRecord(store.sidecar, s.id);
    expect(after?.updated_at).toBe(u.updated_at);

    const auditRows = store.sidecar.db
      .prepare("SELECT op FROM audit WHERE record_id = ? ORDER BY ts ASC")
      .all(s.id) as { op: string }[];
    const ops = auditRows.map((r) => r.op);
    expect(ops).toContain("create");
    expect(ops).toContain("update");
  });

  it("updateMemory persists new body and getMemory returns it", async () => {
    const m = await createMemory(
      store,
      {
        topic: { domain: "d", subject: "s" },
        body: "original body content",
        scope: "project",
        reason: "init",
      },
      AUTHOR,
    );
    await new Promise((r) => setTimeout(r, 5));
    await updateMemory(
      store,
      { id: m.id, body: "rewritten body content keyword", reason: "rewrite" },
      AUTHOR,
    );
    const read = await getMemory(store, { id: m.id });
    expect(read?.body).toBe("rewritten body content keyword");
  });
});

// ─── FR-31e(ii) — role tool catalogs contain no `memory_*` legacy names ───

describe("FR-31e(ii) — deleted legacy stub names are gone from tool catalogs", () => {
  it("knowledgeSkillsTools exposes exactly the §C.2 set (no memory_*/index_* names)", () => {
    const names = knowledgeSkillsTools.map((t) => t.name).sort();
    expect(names).toEqual([
      "archive_skill",
      "create_skill",
      "delete_skill",
      "list_skills",
      "read_skill",
      "search_skills",
      "supersede_skill",
      "update_skill",
    ]);
    for (const n of names) {
      expect(n.startsWith("memory_")).toBe(false);
      expect(n.startsWith("index_")).toBe(false);
    }
  });

  it("knowledgeMemoryTools exposes exactly the §C.2 set (no memory_*/index_* legacy names)", () => {
    const names = knowledgeMemoryTools.map((t) => t.name).sort();
    expect(names).toEqual([
      "archive_memory",
      "create_memory",
      "delete_memory",
      "get_memory",
      "list_memories",
      "search_memories",
      "supersede_memory",
      "update_memory",
    ]);
    for (const n of names) {
      expect(n.startsWith("memory_")).toBe(false);
      expect(n.startsWith("index_")).toBe(false);
    }
  });
});

// ─── FR-31f (read-side) — secret-shaped body is redacted on read ──────────

describe("FR-31f (read-side) — redactForRead masks provider tokens on the wire", () => {
  it("returns redacted_spans>=1 and removes the secret substring", () => {
    const body = "before sk-" + "A".repeat(40) + " after";
    const out = redactForRead(body);
    expect(out.redacted_spans).toBeGreaterThanOrEqual(1);
    expect(out.text.includes("sk-")).toBe(false);
  });

  it("getMemory on a body-with-secret returns the redacted form with redacted_spans counter", async () => {
    // Bypass the write-side guard by patching the sidecar body column
    // directly (write-side scanForSecrets would reject this on createMemory).
    const m = await createMemory(
      store,
      {
        topic: { domain: "d", subject: "leaky-on-disk" },
        body: "placeholder",
        scope: "project",
        reason: "seed",
      },
      AUTHOR,
    );
    const leakyBody = "key: sk-" + "A".repeat(40) + " more";
    store.sidecar.db
      .prepare("UPDATE record SET body = ? WHERE id = ?")
      .run(leakyBody, m.id);
    const read = await getMemory(store, { id: m.id });
    expect(read).not.toBeNull();
    expect(read?.redacted_spans).toBeGreaterThanOrEqual(1);
    expect(read?.body.includes("sk-")).toBe(false);
  });
});
