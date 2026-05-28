/**
 * Saivage — MCP `skills` service handler (M2 / WI-07).
 *
 * Thin adapter (§C.1) over `src/knowledge/lifecycle.ts`. Each tool:
 *   1. asserts `ctx` is present
 *   2. resolves the agent role + `op` from the tool name
 *   3. calls `canCall(role, op, "skill")` → `UNAUTHORIZED_ROLE`
 *   4. for writes, calls lifecycle helpers which enforce reason,
 *      scope-path coherence, secret/blocked-path guards, atomic IO,
 *      audit + index rebuild (§C.3 step order).
 *   5. for reads, returns redacted view via `redactForRead`.
 *
 * Source of truth: SPEC/v2/skills-memory/01-DESIGN.md §C.1 (tools 1-8),
 * §F (permission matrix).
 */

import type { ToolEntry } from "./types.js";
import type { InProcessToolHandler } from "./runtime.js";
import { canCall } from "../knowledge/permissions.js";
import { KnowledgeStoreError } from "../knowledge/store.js";
import type { KnowledgeStore } from "../knowledge/init.js";
import {
  archiveSkill,
  createSkill,
  deleteSkill,
  listSkills,
  readSkillById,
  searchSkills,
  supersedeSkill,
  updateSkill,
  type AuthorAgent,
} from "../knowledge/lifecycle.js";
import {
  KnowledgeAgentRoleSchema,
  type KnowledgeAgentRole,
  type KnowledgeScope,
} from "../knowledge/types.js";

export const knowledgeSkillsTools: ToolEntry[] = [
  {
    name: "create_skill",
    description: "Create a skill (procedural how-to). Roles: Pl/Mg.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        body: { type: "string" },
        triggers: { type: "array", items: { type: "string" } },
        target_agents: { type: "array", items: { type: "string" } },
        scope: { type: "string", enum: ["project", "stage", "session"] },
        scope_ref: { type: "string" },
        expires_at: { type: "string" },
        ttl_ms: { type: "number" },
        survive_compaction: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["name", "description", "body", "scope", "reason"],
    },
  },
  {
    name: "update_skill",
    description: "Update skill fields in place. Roles: Pl/Mg.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        description: { type: "string" },
        triggers: { type: "array", items: { type: "string" } },
        target_agents: { type: "array", items: { type: "string" } },
        expires_at: { type: "string" },
        ttl_ms: { type: "number" },
        reason: { type: "string" },
      },
      required: ["id", "reason"],
    },
  },
  {
    name: "supersede_skill",
    description: "Replace an active skill with a new record. Roles: Mg/In.",
    inputSchema: {
      type: "object",
      properties: {
        old_id: { type: "string" },
        new_record: { type: "object" },
        reason: { type: "string" },
      },
      required: ["old_id", "new_record", "reason"],
    },
  },
  {
    name: "archive_skill",
    description: "Mark a skill archived. Roles: Mg/In.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, reason: { type: "string" } },
      required: ["id", "reason"],
    },
  },
  {
    name: "delete_skill",
    description: "Hard-delete a skill record + body file. Roles: Mg/In.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, reason: { type: "string" } },
      required: ["id", "reason"],
    },
  },
  {
    name: "list_skills",
    description: "List skill records, filtered by scope/target_agent.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["project", "stage", "session"] },
        target_agent: { type: "string" },
        include_archived: { type: "boolean" },
        include_superseded: { type: "boolean" },
      },
    },
  },
  {
    name: "read_skill",
    description: "Read a skill record + body (secrets redacted at read).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "search_skills",
    description: "Full-text search active skills. Scored 3·name + 2·triggers + 1·description+body.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: { type: "string", enum: ["project", "stage", "session"] },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
];

function validateCtx(ctx: unknown): ctx is {
  role: string; agentId: string; projectRoot: string; stageId?: string; channelId?: string;
} {
  return !!ctx && typeof ctx === "object";
}

function resolveRole(role: string): KnowledgeAgentRole {
  const parsed = KnowledgeAgentRoleSchema.safeParse(role);
  if (!parsed.success) {
    throw new KnowledgeStoreError("UNAUTHORIZED_ROLE", `unknown role: ${role}`);
  }
  return parsed.data;
}

function authorOf(ctx: { role: string; agentId: string }): AuthorAgent {
  return { role: resolveRole(ctx.role), agent_id: ctx.agentId };
}

function ok(content: unknown) { return { content, isError: false }; }
function err(code: string, message: string) {
  return { content: { error: { code, message } }, isError: true };
}

function gateRole(role: KnowledgeAgentRole, op: "create" | "read" | "supersede" | "archive" | "search") {
  if (!canCall(role, op, "skill")) {
    throw new KnowledgeStoreError("UNAUTHORIZED_ROLE", "role=" + role + " cannot " + op + " skill");
  }
}

export function makeKnowledgeSkillsHandler(store: KnowledgeStore): InProcessToolHandler {
  return async (toolName, args, ctx) => {
    if (!validateCtx(ctx)) {
      return err("UNAUTHORIZED_ROLE", "ToolCallContext required for knowledge ops");
    }
    const role = resolveRole(ctx.role);
    const author = authorOf(ctx);
    try {
      switch (toolName) {
        case "create_skill": {
          gateRole(role, "create");
          const result = await createSkill(store, {
            name: String(args.name),
            description: String(args.description),
            body: String(args.body),
            triggers: (args.triggers as string[] | undefined) ?? [],
            target_agents: (args.target_agents as KnowledgeAgentRole[] | undefined) ?? [],
            scope: args.scope as KnowledgeScope,
            ...(args.scope_ref !== undefined ? { scope_ref: String(args.scope_ref) } : {}),
            ...(args.expires_at !== undefined ? { expires_at: String(args.expires_at) } : {}),
            ...(args.ttl_ms !== undefined ? { ttl_ms: Number(args.ttl_ms) } : {}),
            ...(args.survive_compaction !== undefined ? { survive_compaction: Boolean(args.survive_compaction) } : {}),
            reason: String(args.reason),
          }, author);
          return ok(result);
        }
        case "update_skill": {
          gateRole(role, "create"); // update follows create per §F
          const result = await updateSkill(store, {
            id: String(args.id),
            ...(args.body !== undefined ? { body: String(args.body) } : {}),
            ...(args.description !== undefined ? { description: String(args.description) } : {}),
            ...(args.triggers !== undefined ? { triggers: args.triggers as string[] } : {}),
            ...(args.target_agents !== undefined ? { target_agents: args.target_agents as KnowledgeAgentRole[] } : {}),
            ...(args.expires_at !== undefined ? { expires_at: String(args.expires_at) } : {}),
            ...(args.ttl_ms !== undefined ? { ttl_ms: Number(args.ttl_ms) } : {}),
            reason: String(args.reason),
          }, author);
          return ok(result);
        }
        case "supersede_skill": {
          gateRole(role, "supersede");
          const nr = (args.new_record ?? {}) as Record<string, unknown>;
          const result = await supersedeSkill(store, {
            old_id: String(args.old_id),
            new_record: {
              name: String(nr.name),
              description: String(nr.description),
              body: String(nr.body),
              triggers: (nr.triggers as string[] | undefined) ?? [],
              target_agents: (nr.target_agents as KnowledgeAgentRole[] | undefined) ?? [],
              scope: nr.scope as KnowledgeScope,
              ...(nr.scope_ref !== undefined ? { scope_ref: String(nr.scope_ref) } : {}),
              ...(nr.expires_at !== undefined ? { expires_at: String(nr.expires_at) } : {}),
              ...(nr.ttl_ms !== undefined ? { ttl_ms: Number(nr.ttl_ms) } : {}),
              ...(nr.survive_compaction !== undefined ? { survive_compaction: Boolean(nr.survive_compaction) } : {}),
              reason: String(args.reason),
            },
            reason: String(args.reason),
          }, author);
          return ok(result);
        }
        case "archive_skill": {
          gateRole(role, "archive");
          return ok(await archiveSkill(store, String(args.id), String(args.reason), author));
        }
        case "delete_skill": {
          gateRole(role, "archive"); // delete follows archive per §F
          return ok(await deleteSkill(store, String(args.id), String(args.reason), author));
        }
        case "list_skills": {
          gateRole(role, "read");
          return ok({
            skills: await listSkills(store, {
              ...(args.scope !== undefined ? { scope: args.scope as KnowledgeScope } : {}),
              ...(args.target_agent !== undefined ? { target_agent: args.target_agent as KnowledgeAgentRole } : {}),
              ...(args.include_archived !== undefined ? { include_archived: Boolean(args.include_archived) } : {}),
              ...(args.include_superseded !== undefined ? { include_superseded: Boolean(args.include_superseded) } : {}),
            }),
          });
        }
        case "read_skill": {
          gateRole(role, "read");
          return ok(await readSkillById(store, String(args.id)));
        }
        case "search_skills": {
          gateRole(role, "search");
          return ok(await searchSkills(
            store,
            {
              q: String(args.query),
              ...(args.limit !== undefined ? { topK: Number(args.limit) } : {}),
            },
            {
              ...(ctx.stageId !== undefined ? { stageId: ctx.stageId } : {}),
              ...(ctx.channelId !== undefined ? { channelId: ctx.channelId } : {}),
            },
          ));
        }
        default:
          return err("UNKNOWN_TOOL", "unknown skills tool: " + toolName);
      }
    } catch (e) {
      if (e instanceof KnowledgeStoreError) {
        return err(e.code, e.message);
      }
      return err("INTERNAL", e instanceof Error ? e.message : String(e));
    }
  };
}

