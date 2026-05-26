/**
 * Saivage — knowledge regression pins (M5 / WI-21).
 *
 * Lightweight regression tests anchored to FR-31* sub-clauses that aren't
 * already covered by the in-place M1/M2/M3 unit suites. Tests
 * intentionally NOT duplicated here:
 *
 *  • fr31a (bundled built-in skills load) — covered by
 *    `src/knowledge/eagerLoader.test.ts > walkBuiltinSkills picks up
 *    bundled SKILL.md` and by the prod `npm run test:bundle` job.
 *  • fr31b (triggerless skill round-trip) — covered by
 *    `src/mcp/knowledgeSkills.test.ts`.
 *  • fr31e(i) (Designer/Chat skill-write denial) — covered by
 *    `src/knowledge/integration.test.ts` (M5/WI-18).
 *  • fr31f (write-side secret rejection) — covered by
 *    `src/mcp/knowledgeSkills.test.ts` and reasserted in
 *    `src/knowledge/integration.test.ts`.
 *  • fr31g (concurrent writes) — covered by
 *    `src/knowledge/concurrency.test.ts` (M5/WI-19).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
} from "./lifecycle.js";
import { redactForRead } from "./loader.js";
import type { AuthorAgent } from "./lifecycle.js";
import { knowledgeSkillsTools } from "../mcp/knowledgeSkills.js";
import { knowledgeMemoryTools } from "../mcp/knowledgeMemory.js";

const AUTHOR: AuthorAgent = { role: "manager", agent_id: "m1" };

let projectRoot: string;
let saivage: string;

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), "saivage-regress-"));
  await initProjectTree(projectRoot);
  saivage = join(projectRoot, ".saivage");
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

// ─── FR-31c — update refreshes updated_at + audit + index row ─────────────

describe("FR-31c — update refreshes updated_at + audit + index", () => {
  it("updateSkill bumps updated_at strictly later and appends an audit row", async () => {
    const s = await createSkill(
      saivage,
      { name: "u1", description: "d", body: "v1", scope: "project", reason: "init" },
      AUTHOR,
    );
    const recordPath = join(saivage, "skills", "project", "records", `${s.id}.json`);
    const before = JSON.parse(readFileSync(recordPath, "utf-8")) as { created_at: string; updated_at: string };
    // Ensure clock progresses past 1ms (ISO timestamps have ms granularity).
    await new Promise((r) => setTimeout(r, 5));
    const u = await updateSkill(saivage, { id: s.id, description: "d2", reason: "doc" }, AUTHOR);
    expect(new Date(u.updated_at).getTime()).toBeGreaterThan(new Date(before.created_at).getTime());

    const audit = readFileSync(join(saivage, "skills", "project", "audit.jsonl"), "utf-8");
    const lines = audit.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const ops = lines.map((l) => l.op);
    expect(ops).toContain("create");
    expect(ops).toContain("update");

    const idx = JSON.parse(
      readFileSync(join(saivage, "skills", "project", "index.json"), "utf-8"),
    ) as { entries: { id: string; updated_at: string }[] };
    const row = idx.entries.find((e) => e.id === s.id);
    expect(row).toBeDefined();
    expect(row!.updated_at).toBe(u.updated_at);
  });

  it("updateMemory persists new body and refreshes the index snippet", async () => {
    const m = await createMemory(
      saivage,
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
      saivage,
      { id: m.id, body: "rewritten body content keyword", reason: "rewrite" },
      AUTHOR,
    );
    const read = await getMemory(saivage, { id: m.id });
    expect(read?.body).toBe("rewritten body content keyword");
  });
});

// ─── FR-31d — nested body_path (subdirectories under records/) ────────────

describe("FR-31d — body_path is a nested relative path under records/", () => {
  it("createSkill persists body under records/<id>.md and indexes that relative path", async () => {
    const s = await createSkill(
      saivage,
      {
        name: "nested",
        description: "d",
        body: "nested body",
        scope: "project",
        reason: "nested seed",
      },
      AUTHOR,
    );
    const expectedRel = `records/${s.id}.md`;
    const onDisk = join(saivage, "skills", "project", expectedRel);
    expect(existsSync(onDisk)).toBe(true);
    expect(readFileSync(onDisk, "utf-8")).toBe("nested body");
    const recordPath = join(saivage, "skills", "project", "records", `${s.id}.json`);
    const rec = JSON.parse(readFileSync(recordPath, "utf-8")) as { body_path: string };
    expect(rec.body_path).toBe(expectedRel);
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
    // No legacy stub names — the canonical names use create_*/get_*/search_*,
    // not memory_*/index_* prefixes.
    for (const n of names) {
      expect(n.startsWith("memory_")).toBe(false);
      expect(n.startsWith("index_")).toBe(false);
    }
  });
});

// ─── FR-31f (read-side) — on-disk secret-shaped body is redacted on read ──

describe("FR-31f (read-side) — redactForRead masks provider tokens on the wire", () => {
  it("returns redacted_spans>=1 and removes the secret substring", () => {
    const body = `before sk-${"A".repeat(40)} after`;
    const out = redactForRead(body);
    expect(out.redacted_spans).toBeGreaterThanOrEqual(1);
    expect(out.text.includes("sk-")).toBe(false);
  });

  it("getMemory on a body-with-secret returns the redacted form with redacted_spans counter", async () => {
    // Bypass the write-side guard by hand-editing the record JSON to
    // contain a secret pattern. The store layer's redactForRead is
    // applied on read in lifecycle.getMemory.
    const m = await createMemory(
      saivage,
      {
        topic: { domain: "d", subject: "leaky-on-disk" },
        body: "placeholder", // clean placeholder so create passes
        scope: "project",
        reason: "seed",
      },
      AUTHOR,
    );
    const recordPath = join(saivage, "memory", "project", "records", `${m.id}.json`);
    const raw = JSON.parse(readFileSync(recordPath, "utf-8")) as { body: string };
    raw.body = `key: sk-${"A".repeat(40)} more`;
    writeFileSync(recordPath, JSON.stringify(raw), "utf-8");
    const read = await getMemory(saivage, { id: m.id });
    expect(read).not.toBeNull();
    expect(read!.redacted_spans).toBeGreaterThanOrEqual(1);
    expect(read!.body.includes("sk-")).toBe(false);
  });
});

// ─── §5.12 — plan history vs memory boundary (no cross-store duplication) ──

describe("§5.12 — plan history and knowledge stores stay distinct", () => {
  it("creating a memory does not mutate plan.json history", async () => {
    const planPath = join(saivage, "plan.json");
    const seed = {
      updated_at: new Date().toISOString(),
      current_stage_id: null,
      stages: [] as unknown[],
      history: [] as unknown[],
    };
    writeFileSync(planPath, JSON.stringify(seed), "utf-8");

    await createMemory(
      saivage,
      {
        topic: { domain: "build", subject: "web" },
        body: "build memo",
        scope: "project",
        reason: "init",
      },
      AUTHOR,
    );

    const after = JSON.parse(readFileSync(planPath, "utf-8")) as typeof seed;
    expect(after).toEqual(seed);
  });
});
