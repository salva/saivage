/**
 * Saivage — Knowledge store types (skills + memories).
 *
 * Source of truth: docs/internals/knowledge/skills-and-memory.md
 * (schemas + lifecycle). Schemas are additive; no consumers yet (WI-01).
 */

import { z } from "zod";

/**
 * Roles that may appear as `author_agent.role` on a knowledge record.
 * Aligned with SPEC §F (ten roles including `designer` and `critic`). Kept distinct
 * from `AgentRole` in `src/agents/types.ts` because the knowledge layer
 * accepts every authoring role independently of which roles are currently
 * wired into the agent registry.
 */
export const KnowledgeAgentRoleSchema = z.enum([
  "planner",
  "manager",
  "coder",
  "researcher",
  "data_agent",
  "inspector",
  "reviewer",
  "designer",
  "critic",
  "chat",
  "librarian",
]);
export type KnowledgeAgentRole = z.infer<typeof KnowledgeAgentRoleSchema>;

/** Lifecycle states (design §B.2). */
export const LifecycleStatusSchema = z.enum([
  "active",
  "superseded",
  "archived",
  "expired",
]);
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;

/** Scope of a knowledge record (design §B.3). */
export const KnowledgeScopeSchema = z.enum(["project", "stage", "session"]);
export type KnowledgeScope = z.infer<typeof KnowledgeScopeSchema>;

/** Skill origin (design §B.1). */
export const SkillOriginSchema = z.enum(["builtin", "project"]);
export type SkillOrigin = z.infer<typeof SkillOriginSchema>;

/** Audit op kinds (design §B.1 AuditEntry). */
export const AuditOpSchema = z.enum([
  "create",
  "update",
  "supersede",
  "archive",
  "unarchive",
  "delete",
  "expire",
]);
export type AuditOp = z.infer<typeof AuditOpSchema>;

/**
 * F01 — Record id schema: a v4 UUID OR a stable `builtin:<slug>` id.
 * Built-in skills shipped with Saivage carry deterministic ids so they
 * remain stable across boots; project-authored records always use UUIDs.
 */
export const RecordIdSchema = z.union([
  z.string().uuid(),
  z.string().regex(/^builtin:[a-z0-9][a-z0-9._-]*$/),
]);
export type RecordId = z.infer<typeof RecordIdSchema>;

const AuthorAgentSchema = z.object({
  role: KnowledgeAgentRoleSchema,
  agent_id: z.string().min(1),
});

const SourceProvenanceSchema = z.object({
  stage_id: z.string().optional(),
  task_id: z.string().optional(),
});

/**
 * Common record fields shared by `SkillRecord` and `MemoryRecord`.
 * The `(scope, scope_ref)` refinement enforces that stage/session-scoped
 * records carry a scope_ref (design §B.1 refinement).
 */
const RecordBaseShape = {
  id: RecordIdSchema,
  kind: z.enum(["skill", "memory"]),
  scope: KnowledgeScopeSchema,
  status: LifecycleStatusSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  author_agent: AuthorAgentSchema,
  source: SourceProvenanceSchema.optional(),
  scope_ref: z.string().min(1).optional(),
  expires_at: z.string().datetime().optional(),
  ttl_ms: z.number().int().positive().optional(),
  supersedes: RecordIdSchema.optional(),
  superseded_by: RecordIdSchema.optional(),
  relates_to: z.array(RecordIdSchema).max(16).default([]),
  survive_compaction: z.boolean().default(false),
} as const;

const scopeRefRefinement = <T extends { scope: KnowledgeScope; scope_ref?: string }>(r: T) =>
  r.scope === "project" || (typeof r.scope_ref === "string" && r.scope_ref.length > 0);

const scopeRefRefinementMsg = {
  message: "scope_ref is required when scope is 'stage' or 'session'",
} as const;

export const RecordBaseSchema = z
  .object(RecordBaseShape)
  .refine(scopeRefRefinement, scopeRefRefinementMsg);
export type RecordBase = z.infer<typeof RecordBaseSchema>;

export const SkillRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal("skill"),
    origin: SkillOriginSchema.default("project"),
    name: z.string().min(1),
    description: z.string(),
    triggers: z.array(z.string()).default([]),
    target_agents: z.array(KnowledgeAgentRoleSchema).default([]),
  })
  .refine(scopeRefRefinement, scopeRefRefinementMsg);
export type SkillRecord = z.infer<typeof SkillRecordSchema>;

/**
 * Frontmatter contract for bundled skills under `skills/builtin/<topic>/SKILL.md`.
 * `target_agents: []` is the canonical spelling for a global built-in and
 * must be declared deliberately.
 */
export const BuiltinSkillFrontmatterSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    triggers: z.array(z.string()).default([]),
    target_agents: z.array(KnowledgeAgentRoleSchema),
    survive_compaction: z.boolean().default(false),
  })
  .strict();
export type BuiltinSkillFrontmatter = z.infer<typeof BuiltinSkillFrontmatterSchema>;

const TopicSchema = z.object({
  domain: z.string().min(1),
  subject: z.string().min(1),
  aspect: z.string().optional(),
});
export type Topic = z.infer<typeof TopicSchema>;

const SourceRefSchema = z.object({
  kind: z.enum(["inspection", "task_report", "stage_summary"]),
  id: z.string().min(1),
});

export const MemoryRecordSchema = z
  .object({
    ...RecordBaseShape,
    kind: z.literal("memory"),
    topic: TopicSchema,
    keys: z.array(z.string()).default([]),
    target_agents: z.array(KnowledgeAgentRoleSchema).default([]),
    body: z.string(),
    source_ref: SourceRefSchema.optional(),
  })
  .refine(scopeRefRefinement, scopeRefRefinementMsg);
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

/** One audit row per lifecycle event; design §B.1 AuditEntry. */
export const AuditEntrySchema = z.object({
  ts: z.string().datetime(),
  record_id: RecordIdSchema,
  op: AuditOpSchema,
  outcome: z.enum(["ok", "rejected"]).default("ok"),
  error_code: z.string().optional(),
  author_agent: AuthorAgentSchema,
  reason: z.string(),
  prev_status: LifecycleStatusSchema.optional(),
  next_status: LifecycleStatusSchema.optional(),
  content_hash_before: z.string().optional(),
  content_hash_after: z.string().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** Union of either knowledge record kind. */
export type KnowledgeRecord = SkillRecord | MemoryRecord;
