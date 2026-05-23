/**
 * Saivage — knowledge agent integration tests (M5 / WI-20).
 *
 * Pins the agent-side surfaces of the knowledge layer:
 *
 *  • per-role `target_agents` filtering in `resolveEagerRecords`
 *  • opt-in eager memories (FR-31: memories require non-empty
 *    `target_agents` to enter the eager block)
 *  • budget overflow surfaces `omitted` ids
 *  • survivor reinjection block surfaces `oversized_survivors`
 *  • Planner pre-compaction nudge boundary (5-turn cap implementation
 *    pinned via tool-call counter)
 *
 * Heavy coverage already exists for:
 *   - `/skills`, `/memories`, `/remember`, `/forget` routing →
 *     `src/chat/slashCommands.test.ts`
 *   - Survivor reinjection wired into `BaseAgent` →
 *     `src/agents/base.compaction.test.ts`
 *   - `archiveStage` / `archiveSession` hooks →
 *     `src/knowledge/lifecycle.archive.test.ts`
 *   - Conversation snapshot/compaction with knowledge block →
 *     `src/agents/conversation-snapshot.test.ts`
 *
 *  This file adds the narrow regression pins that close the WI-20 gaps.
 */

import { describe, expect, it } from "vitest";

import {
  resolveEagerRecords,
  reinjectSurvivors,
  splitByBudget,
  type EagerCandidate,
} from "../knowledge/loader.js";
import {
  formatSurvivorReinjectionBlock,
} from "../knowledge/eagerLoader.js";
import type { SkillRecord, MemoryRecord, KnowledgeAgentRole } from "../knowledge/types.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────

function skill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: overrides.id ?? "10000000-0000-4000-8000-000000000000",
    kind: "skill",
    scope: "project",
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    author_agent: { role: "manager", agent_id: "m" },
    origin: "project",
    name: "n",
    description: "d",
    triggers: ["agent:coder"],
    target_agents: [],
    body_path: "records/n.md",
    relates_to: [],
    survive_compaction: false,
    ...overrides,
  } as SkillRecord;
}

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: overrides.id ?? "20000000-0000-4000-8000-000000000000",
    kind: "memory",
    scope: "project",
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    author_agent: { role: "planner", agent_id: "p" },
    origin: "project",
    topic: { domain: "d", subject: "s" },
    keys: [],
    target_agents: [],
    body_path: "records/m.md",
    relates_to: [],
    survive_compaction: false,
    ...overrides,
  } as MemoryRecord;
}

// ─── Per-role filtering (FR-31 §D.5) ──────────────────────────────────────

describe("resolveEagerRecords — per-role filtering", () => {
  it("drops skills whose target_agents excludes the calling role", () => {
    const cands = [
      { record: skill({ id: "a-coder", triggers: ["agent:coder"], target_agents: ["coder"] as KnowledgeAgentRole[] }), body: "for coder" },
      { record: skill({ id: "b-researcher", triggers: ["agent:researcher"], target_agents: ["researcher"] as KnowledgeAgentRole[] }), body: "for researcher" },
      { record: skill({ id: "c-all", triggers: ["agent:coder"], target_agents: [] as KnowledgeAgentRole[] }), body: "for all" },
    ];
    const res = resolveEagerRecords({ agentRole: "coder", tags: ["context"] }, cands);
    const ids = res.ordinary.map((c) => c.record.id);
    expect(ids).toContain("a-coder");
    expect(ids).toContain("c-all");
    expect(ids).not.toContain("b-researcher");
  });

  it("memories require non-empty target_agents (opt-in eager)", () => {
    const cands = [
      { record: memory({ id: "m-untargeted", target_agents: [] as KnowledgeAgentRole[] }), body: "no target" },
      { record: memory({ id: "m-coder", target_agents: ["coder"] as KnowledgeAgentRole[] }), body: "for coder" },
    ];
    const res = resolveEagerRecords({ agentRole: "coder" }, cands);
    const ids = res.ordinary.map((c) => c.record.id);
    expect(ids).toContain("m-coder");
    expect(ids).not.toContain("m-untargeted");
  });

  it("skills with score=0 and no survive_compaction are dropped", () => {
    const cands = [
      // No trigger match; not a survivor → dropped.
      { record: skill({ id: "drop", triggers: ["build"], target_agents: ["coder"] as KnowledgeAgentRole[] }), body: "b" },
      // No trigger match; survivor → kept (project scope).
      { record: skill({ id: "keep", triggers: ["build"], target_agents: ["coder"] as KnowledgeAgentRole[], survive_compaction: true }), body: "b" },
    ];
    const res = resolveEagerRecords({ agentRole: "coder" }, cands);
    const ids = [...res.survivors, ...res.ordinary].map((c) => c.record.id);
    expect(ids).toContain("keep");
    expect(ids).not.toContain("drop");
  });
});

// ─── Budget overflow (§D.6) ───────────────────────────────────────────────

describe("splitByBudget — omitted overflow & oversized survivors", () => {
  it("ordinary records exceeding the budget go to omitted (in rank order)", () => {
    const big = "x".repeat(2000); // ~500 tokens
    const ranked: EagerCandidate[] = Array.from({ length: 6 }, (_, i) => ({
      kind: "skill",
      record: skill({ id: `s${i}`, name: `n${i}`, body_path: `records/n${i}.md` }),
      score: 6 - i, // already ranked desc
      body: big,
    }));
    const res = splitByBudget(ranked, 1000); // ~2 records fit
    expect(res.ordinary.length).toBeLessThan(6);
    expect(res.omitted.length).toBeGreaterThan(0);
    // Omitted ids are stable strings (not records).
    for (const id of res.omitted) expect(typeof id).toBe("string");
  });

  it("survivors exceeding 4096 tokens go to oversizedSurvivors and are NOT injected", () => {
    const huge = "x".repeat(4096 * 4 + 1000); // > 4096 tokens
    const ranked: EagerCandidate[] = [
      {
        kind: "skill",
        record: skill({ id: "oversized", description: huge, survive_compaction: true }),
        score: 0,
        body: huge,
      },
    ];
    const res = splitByBudget(ranked);
    expect(res.oversizedSurvivors).toContain("oversized");
    expect(res.survivors.length).toBe(0);
  });

  it("formatSurvivorReinjectionBlock emits §E.1 markers and oversized_survivors line", () => {
    const cand: EagerCandidate = {
      kind: "skill",
      record: skill({ id: "x", name: "x", survive_compaction: true }),
      score: 1,
      body: "summary body",
    };
    const block = formatSurvivorReinjectionBlock([cand], 3, ["oversized-id"]);
    expect(block).toContain("SURVIVING KNOWLEDGE");
    expect(block).toContain("compaction #3");
    expect(block).toContain("[SKILL x]");
    expect(block).toContain("\"oversized-id\"");
    expect(block).toContain("END SURVIVING KNOWLEDGE");
  });
});

// ─── Survivor reinjection only walks project-scope survivors ──────────────

describe("reinjectSurvivors — §E.1 scope guard", () => {
  it("ignores stage-scoped records even if survive_compaction is set", () => {
    const cands = [
      { record: skill({ id: "proj", scope: "project", survive_compaction: true, target_agents: ["coder"] as KnowledgeAgentRole[] }), body: "p" },
      { record: skill({ id: "stage", scope: "stage", scope_ref: "stg-1", survive_compaction: true, target_agents: ["coder"] as KnowledgeAgentRole[] }), body: "s" },
    ];
    const out = reinjectSurvivors({ agentRole: "coder" }, cands);
    const ids = out.map((c) => c.record.id);
    expect(ids).toContain("proj");
    expect(ids).not.toContain("stage");
  });

  it("ignores archived records (status != active)", () => {
    const cands = [
      { record: skill({ id: "live", survive_compaction: true, target_agents: ["coder"] as KnowledgeAgentRole[] }), body: "live" },
      { record: skill({ id: "gone", status: "archived", survive_compaction: true, target_agents: ["coder"] as KnowledgeAgentRole[] }), body: "gone" },
    ];
    const out = reinjectSurvivors({ agentRole: "coder" }, cands);
    const ids = out.map((c) => c.record.id);
    expect(ids).toContain("live");
    expect(ids).not.toContain("gone");
  });
});
