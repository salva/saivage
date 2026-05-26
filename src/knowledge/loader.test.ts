import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { MemoryRecord, SkillRecord } from "./types.js";
import {
  DEFAULTS,
  canonicalize,
  canonicalizeTokens,
  estimateTokens,
  redactForRead,
  reinjectSurvivors,
  resolveEagerRecords,
  scoreMemoryForSearch,
  scoreSkillForSearch,
  scoreSkillTriggers,
  splitByBudget,
  type EagerCandidate,
} from "./loader.js";
import { builtinAsSkillRecord, parseSkillFrontmatter, walkBuiltinSkills } from "./builtinWalker.js";

const NOW = "2026-05-23T00:00:00.000Z";
const AUTHOR = { role: "manager" as const, agent_id: "agent-1" };

function makeSkill(over: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: over.id ?? "11111111-1111-4111-8111-111111111111",
    kind: "skill",
    scope: "project",
    status: "active",
    created_at: NOW,
    updated_at: NOW,
    author_agent: AUTHOR,
    name: "coding-style",
    description: "Style guide for the project.",
    body_path: "records/x.md",
    triggers: [],
    target_agents: [],
    relates_to: [],
    survive_compaction: false,
    origin: "project",
    ...over,
  } as SkillRecord;
}

function makeMemory(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: over.id ?? "22222222-2222-4222-8222-222222222222",
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
  } as MemoryRecord;
}

describe("canonicalize", () => {
  it("NFC + lowercase + strip punct + collapse ws", () => {
    expect(canonicalize("  Hello,  WORLD!  ")).toBe("hello world");
    expect(canonicalizeTokens("foo-bar_baz QUX")).toEqual(["foo", "bar_baz", "qux"]);
    // unicode NFC: combined é survives lowercasing
    expect(canonicalize("Café")).toBe("café");
  });

  it("empty input → empty array", () => {
    expect(canonicalizeTokens("")).toEqual([]);
    expect(canonicalizeTokens(null)).toEqual([]);
  });
});

describe("scoreSkillTriggers", () => {
  const ctx = { agentRole: "coder" as const, description: "implement build script", tags: ["ci"] };

  it("returns 0 for triggerless skills", () => {
    expect(scoreSkillTriggers([], ctx)).toBe(0);
  });

  it("matches keyword: against task description", () => {
    expect(scoreSkillTriggers(["keyword:build"], ctx)).toBe(1);
    expect(scoreSkillTriggers(["keyword:absent"], ctx)).toBe(0);
  });

  it("matches tag: against task tags (2x weight)", () => {
    expect(scoreSkillTriggers(["tag:ci"], ctx)).toBe(2);
  });

  it("matches agent: against role (3x weight)", () => {
    expect(scoreSkillTriggers(["agent:coder"], ctx)).toBe(3);
    expect(scoreSkillTriggers(["agent:manager"], ctx)).toBe(0);
  });

  it("ignores unknown trigger kinds (tool:, path:, garbage)", () => {
    expect(scoreSkillTriggers(["tool:bash", "path:src/", "noprefix"], ctx)).toBe(0);
  });

  it("sums multiple matching triggers", () => {
    expect(scoreSkillTriggers(["keyword:build", "tag:ci", "agent:coder"], ctx)).toBe(1 + 2 + 3);
  });
});

describe("scoreMemoryForSearch", () => {
  const entry = {
    id: "x",
    topic: { domain: "build", subject: "web-app", aspect: "command" },
    keys: ["npm", "vite"],
    body_snippet: "Run npm run build to produce dist/",
    updated_at: NOW,
  };

  it("topic match weighted 3x", () => {
    expect(scoreMemoryForSearch(["build"], entry)).toBe(3 + 1); // body also has "build"
  });

  it("key match weighted 2x", () => {
    expect(scoreMemoryForSearch(["npm"], entry)).toBe(2 + 1);
  });

  it("body-only match weighted 1x", () => {
    expect(scoreMemoryForSearch(["dist"], entry)).toBe(1);
  });

  it("zero tokens → 0", () => {
    expect(scoreMemoryForSearch([], entry)).toBe(0);
  });
});

describe("scoreSkillForSearch", () => {
  const entry = {
    id: "x",
    name: "deploy-pipeline",
    description: "Deploy to staging via GitHub Actions.",
    triggers: ["keyword:deploy", "agent:coder"],
    body_snippet: "Steps: lint, test, deploy.",
    updated_at: NOW,
  };

  it("name match weighted 3x and dedup with triggers", () => {
    // "deploy" appears in name (3) + triggers (3) + description (2) + body (1).
    expect(scoreSkillForSearch(["deploy"], entry)).toBe(3 + 2 + 1);
  });
});

describe("splitByBudget", () => {
  it("survivors are always included as one-line summaries", () => {
    const skill = makeSkill({
      survive_compaction: true,
      description: "short survivor summary",
    });
    const cands: EagerCandidate[] = [
      { kind: "skill", record: skill, score: 0, body: "irrelevant long body", origin: "project" },
    ];
    const r = splitByBudget(cands, 0);
    expect(r.survivors).toHaveLength(1);
    expect(r.survivors[0].body).toBe("short survivor summary");
    expect(r.omitted).toEqual([]);
  });

  it("oversized survivor is quarantined", () => {
    const huge = "x".repeat(DEFAULTS.SURVIVOR_TOKEN_CEILING * 4 + 10);
    const skill = makeSkill({
      survive_compaction: true,
      description: huge,
    });
    const r = splitByBudget(
      [{ kind: "skill", record: skill, score: 0, body: "irrelevant", origin: "project" }],
      DEFAULTS.DEFAULT_ORDINARY_BUDGET_TOKENS,
    );
    expect(r.survivors).toHaveLength(0);
    expect(r.oversizedSurvivors).toEqual([skill.id]);
  });

  it("ordinary records overflow → omitted, not truncated", () => {
    const body = "a".repeat(2048 * 4); // ~2048 tokens
    const c1: EagerCandidate = {
      kind: "memory",
      record: makeMemory({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      score: 5,
      body,
    };
    const c2: EagerCandidate = {
      kind: "memory",
      record: makeMemory({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      score: 4,
      body: "small",
    };
    const r = splitByBudget([c1, c2], 1024);
    expect(r.ordinary).toHaveLength(1);
    expect(r.omitted).toEqual([c1.record.id]);
    expect(r.ordinary[0].record.id).toBe(c2.record.id);
  });
});

describe("resolveEagerRecords", () => {
  it("filters by status and target_agents", () => {
    const cands = [
      { record: makeSkill({ id: "s1", status: "archived" }), body: "x", origin: "project" as const },
      {
        record: makeSkill({
          id: "s2",
          triggers: ["agent:coder"],
          target_agents: ["coder"],
        }),
        body: "x",
        origin: "project" as const,
      },
      {
        record: makeSkill({
          id: "s3",
          triggers: ["agent:coder"],
          target_agents: ["manager"],
        }),
        body: "x",
        origin: "project" as const,
      },
    ];
    const r = resolveEagerRecords({ agentRole: "coder" }, cands);
    expect(r.ordinary.map((c) => c.record.id)).toEqual(["s2"]);
  });

  it("ranks origin=project before origin=builtin at equal score", () => {
    const project = makeSkill({ id: "11111111-1111-4111-8111-111111111111", triggers: ["agent:coder"] });
    const builtin = makeSkill({ id: "22222222-2222-4222-8222-222222222222", triggers: ["agent:coder"] });
    const r = resolveEagerRecords(
      { agentRole: "coder" },
      [
        { record: builtin, body: "b", origin: "builtin" },
        { record: project, body: "p", origin: "project" },
      ],
    );
    expect(r.ordinary[0].record.id).toBe(project.id);
  });

  it("triggerless non-survivor skills are dropped", () => {
    const r = resolveEagerRecords(
      { agentRole: "coder" },
      [{ record: makeSkill({ triggers: [] }), body: "x", origin: "project" }],
    );
    expect(r.ordinary).toHaveLength(0);
  });

  it("triggerless survivor skills are still included as survivors", () => {
    const skill = makeSkill({ triggers: [], survive_compaction: true, description: "survives" });
    const r = resolveEagerRecords(
      { agentRole: "coder" },
      [{ record: skill, body: "x", origin: "project" }],
    );
    expect(r.survivors).toHaveLength(1);
  });

  it("memories without target_agents are excluded from eager pool", () => {
    const mem = makeMemory({ target_agents: [] });
    const r = resolveEagerRecords(
      { agentRole: "coder" },
      [{ record: mem, body: "x", origin: "project" }],
    );
    expect(r.ordinary).toHaveLength(0);
  });

  it("opted-in memory is eligible", () => {
    const mem = makeMemory({ target_agents: ["coder"] });
    const r = resolveEagerRecords(
      { agentRole: "coder" },
      [{ record: mem, body: "x", origin: "project" }],
    );
    expect(r.ordinary).toHaveLength(1);
  });
});

describe("reinjectSurvivors", () => {
  it("returns only project-scope survivors visible to the role", () => {
    const ok = makeSkill({
      id: "11111111-1111-4111-8111-111111111111",
      survive_compaction: true,
      description: "good",
    });
    const wrongScope = makeSkill({
      id: "22222222-2222-4222-8222-222222222222",
      survive_compaction: true,
      scope: "stage",
      scope_ref: "s1",
      description: "stage",
    });
    const wrongRole = makeSkill({
      id: "33333333-3333-4333-8333-333333333333",
      survive_compaction: true,
      target_agents: ["manager"],
      description: "manager-only",
    });
    const survivors = reinjectSurvivors({ agentRole: "coder" }, [
      { record: ok, body: "x", origin: "project" },
      { record: wrongScope, body: "x", origin: "project" },
      { record: wrongRole, body: "x", origin: "project" },
    ]);
    expect(survivors.map((s) => s.record.id)).toEqual([ok.id]);
  });
});

describe("redactForRead", () => {
  it("removes provider-shaped substrings", () => {
    const text = `key: sk-${"A".repeat(40)} more`;
    const out = redactForRead(text);
    expect(out.redacted_spans).toBe(1);
    expect(out.text.includes("sk-")).toBe(false);
  });

  it("no-op on clean text", () => {
    const out = redactForRead("hello world");
    expect(out.redacted_spans).toBe(0);
    expect(out.text).toBe("hello world");
  });
});

describe("estimateTokens", () => {
  it("approximates length/4 (matches compaction.ts)", () => {
    expect(estimateTokens("a".repeat(40))).toBe(10);
    expect(estimateTokens("")).toBe(0);
  });
});

// ─── builtinWalker tests ───────────────────────────────────────────────────

function makeFixtureSkill(root: string, name: string, frontmatter: string, body: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`, "utf-8");
}

describe("parseSkillFrontmatter", () => {
  it("parses scalars, flow arrays, and block arrays", () => {
    const { frontmatter, body } = parseSkillFrontmatter(
      [
        "---",
        'name: "coding-style"',
        "description: My style guide",
        "triggers: [keyword:build, agent:coder]",
        "target_agents:",
        "  - coder",
        "  - reviewer",
        "survive_compaction: true",
        "---",
        "Body content here.",
      ].join("\n"),
    );
    expect(frontmatter.name).toBe("coding-style");
    expect(frontmatter.description).toBe("My style guide");
    expect(frontmatter.triggers).toEqual(["keyword:build", "agent:coder"]);
    expect(frontmatter.target_agents).toEqual(["coder", "reviewer"]);
    expect(frontmatter.survive_compaction).toBe(true);
    expect(body.trim()).toBe("Body content here.");
  });

  it("returns body unchanged when no frontmatter", () => {
    const { frontmatter, body } = parseSkillFrontmatter("just a body");
    expect(frontmatter).toEqual({});
    expect(body).toBe("just a body");
  });

  it("throws on duplicate keys", () => {
    expect(() => parseSkillFrontmatter("---\nname: a\nname: b\n---\nbody")).toThrow(/duplicate/);
  });

  it("rejects malformed lines", () => {
    expect(() => parseSkillFrontmatter("---\nthis is not yaml\n---\n")).toThrow();
  });
});

describe("walkBuiltinSkills + builtinAsSkillRecord", () => {
  it("walks SKILL.md files and projects to records", () => {
    const root = mkdtempSync(join(tmpdir(), "saivage-builtins-"));
    makeFixtureSkill(
      root,
      "alpha",
      'name: "alpha-skill"\ndescription: "first"\ntriggers: [agent:coder]\nsurvive_compaction: true',
      "Alpha body.",
    );
    makeFixtureSkill(
      root,
      "beta",
      'name: "beta-skill"\ndescription: "second"',
      "Beta body.",
    );
    // a directory without SKILL.md must be ignored
    mkdirSync(join(root, "no-skill"), { recursive: true });

    const raws = walkBuiltinSkills(root);
    expect(raws.map((r) => r.name).sort()).toEqual(["alpha-skill", "beta-skill"]);

    const rec = builtinAsSkillRecord(
      raws.find((r) => r.name === "alpha-skill")!,
      "33333333-3333-4333-8333-333333333333",
      NOW,
    );
    expect(rec.origin).toBe("builtin");
    expect(rec.scope).toBe("project");
    expect(rec.survive_compaction).toBe(true);
  });

  it("returns [] for missing dir", () => {
    expect(walkBuiltinSkills(join(tmpdir(), "saivage-nonexistent-" + Date.now()))).toEqual([]);
  });
});
