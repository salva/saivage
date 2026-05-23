import { describe, expect, it } from "vitest";
import {
  AuditEntrySchema,
  KnowledgeAgentRoleSchema,
  LifecycleStatusSchema,
  MemoryRecordSchema,
  RecordBaseSchema,
  SkillRecordSchema,
} from "./types.js";

const baseFields = {
  id: "11111111-1111-4111-8111-111111111111",
  created_at: "2026-05-23T00:00:00.000Z",
  updated_at: "2026-05-23T00:00:00.000Z",
  status: "active" as const,
  author_agent: { role: "manager" as const, agent_id: "agent-1" },
};

describe("KnowledgeAgentRoleSchema", () => {
  it("accepts all nine roles in §F", () => {
    for (const r of [
      "planner",
      "manager",
      "coder",
      "researcher",
      "data_agent",
      "inspector",
      "reviewer",
      "designer",
      "chat",
    ]) {
      expect(KnowledgeAgentRoleSchema.parse(r)).toBe(r);
    }
  });

  it("rejects unknown role", () => {
    expect(() => KnowledgeAgentRoleSchema.parse("supervisor")).toThrow();
  });
});

describe("LifecycleStatusSchema (design §B.2)", () => {
  it("enumerates active|superseded|archived|expired", () => {
    for (const s of ["active", "superseded", "archived", "expired"]) {
      expect(LifecycleStatusSchema.parse(s)).toBe(s);
    }
    expect(() => LifecycleStatusSchema.parse("draft")).toThrow();
  });
});

describe("RecordBaseSchema scope_ref refinement", () => {
  it("accepts project scope without scope_ref", () => {
    const r = RecordBaseSchema.parse({
      ...baseFields,
      kind: "skill",
      scope: "project",
    });
    expect(r.scope).toBe("project");
  });

  it("rejects stage scope without scope_ref", () => {
    expect(() =>
      RecordBaseSchema.parse({
        ...baseFields,
        kind: "skill",
        scope: "stage",
      }),
    ).toThrow(/scope_ref/);
  });

  it("rejects session scope with empty scope_ref", () => {
    expect(() =>
      RecordBaseSchema.parse({
        ...baseFields,
        kind: "memory",
        scope: "session",
        scope_ref: "",
      }),
    ).toThrow();
  });

  it("accepts stage scope with scope_ref", () => {
    const r = RecordBaseSchema.parse({
      ...baseFields,
      kind: "memory",
      scope: "stage",
      scope_ref: "stg-1",
    });
    expect(r.scope_ref).toBe("stg-1");
  });
});

describe("SkillRecordSchema (kind/scope cross product)", () => {
  const skillFields = {
    ...baseFields,
    kind: "skill" as const,
    name: "coding-style",
    description: "Coding style.",
    body_path: "records/abc.md",
  };

  it.each([
    ["project", undefined],
    ["stage", "stg-1"],
    ["session", "chan-1"],
  ] as const)("accepts %s scope", (scope, scope_ref) => {
    const r = SkillRecordSchema.parse({
      ...skillFields,
      scope,
      ...(scope_ref ? { scope_ref } : {}),
    });
    expect(r.kind).toBe("skill");
    expect(r.origin).toBe("project");
    expect(r.triggers).toEqual([]);
    expect(r.target_agents).toEqual([]);
    expect(r.relates_to).toEqual([]);
    expect(r.survive_compaction).toBe(false);
  });

  it("rejects missing name", () => {
    expect(() => SkillRecordSchema.parse({ ...skillFields, scope: "project", name: "" })).toThrow();
  });

  it("rejects relates_to over 16 entries", () => {
    const ids = Array.from({ length: 17 }, (_, i) =>
      `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
    );
    expect(() =>
      SkillRecordSchema.parse({ ...skillFields, scope: "project", relates_to: ids }),
    ).toThrow();
  });
});

describe("MemoryRecordSchema (kind/scope cross product)", () => {
  const memoryFields = {
    ...baseFields,
    kind: "memory" as const,
    topic: { domain: "build", subject: "web-app", aspect: "command" },
    body: "Run `npm run build`.",
  };

  it.each([
    ["project", undefined],
    ["stage", "stg-1"],
    ["session", "chan-1"],
  ] as const)("accepts %s scope", (scope, scope_ref) => {
    const r = MemoryRecordSchema.parse({
      ...memoryFields,
      scope,
      ...(scope_ref ? { scope_ref } : {}),
    });
    expect(r.kind).toBe("memory");
    expect(r.topic.domain).toBe("build");
  });

  it("rejects empty domain", () => {
    expect(() =>
      MemoryRecordSchema.parse({
        ...memoryFields,
        scope: "project",
        topic: { domain: "", subject: "x" },
      }),
    ).toThrow();
  });

  it("rejects stage scope when scope_ref is undefined", () => {
    expect(() =>
      MemoryRecordSchema.parse({ ...memoryFields, scope: "stage" }),
    ).toThrow(/scope_ref/);
  });
});

describe("AuditEntrySchema", () => {
  it("round-trips a happy-path create entry", () => {
    const a = AuditEntrySchema.parse({
      ts: "2026-05-23T00:00:00.000Z",
      record_id: baseFields.id,
      op: "create",
      author_agent: baseFields.author_agent,
      reason: "first version",
    });
    expect(a.outcome).toBe("ok");
  });

  it("accepts rejected outcome with error_code", () => {
    const a = AuditEntrySchema.parse({
      ts: "2026-05-23T00:00:00.000Z",
      record_id: baseFields.id,
      op: "create",
      outcome: "rejected",
      error_code: "SECRET_DETECTED",
      author_agent: baseFields.author_agent,
      reason: "rejected: secret in body",
    });
    expect(a.error_code).toBe("SECRET_DETECTED");
  });

  it("round-trips parse(stringify(record))", () => {
    const valid = AuditEntrySchema.parse({
      ts: "2026-05-23T00:00:00.000Z",
      record_id: baseFields.id,
      op: "supersede",
      author_agent: baseFields.author_agent,
      reason: "supersede old_id=x",
      prev_status: "active",
      next_status: "superseded",
    });
    const round = AuditEntrySchema.parse(JSON.parse(JSON.stringify(valid)));
    expect(round).toEqual(valid);
  });
});
