/**
 * Saivage — MCP `memory` service handler (M2 / WI-08).
 *
 * Thin adapter over `src/knowledge/lifecycle.ts` per design §C.1
 * tools 9-16. Same dispatch shape as `knowledgeSkills.ts`, plus a
 * `checkScope(...)` call on writes to enforce the worker Y† rule for
 * Coder/Researcher (memory create/update only at `scope='stage'`,
 * `scope_ref == ctx.stageId`).
 */

import type { ToolEntry } from "./types.js";
import type { InProcessToolHandler } from "./runtime.js";
import { canCall, checkScope } from "../knowledge/permissions.js";
import { KnowledgeStoreError } from "../knowledge/store.js";
import type { KnowledgeStore } from "../knowledge/init.js";
import { getRecord } from "../knowledge/sidecar-queries.js";
import {
  archiveMemory,
  createMemory,
  deleteMemory,
  getMemory,
  listMemories,
  searchMemories,
  supersedeMemory,
  updateMemory,
  type AuthorAgent,
} from "../knowledge/lifecycle.js";
import {
  KnowledgeAgentRoleSchema,
  type KnowledgeAgentRole,
  type KnowledgeScope,
} from "../knowledge/types.js";

export const knowledgeMemoryTools: ToolEntry[] = [
  {
    name: "create_memory",
    description: "Create a memory (fact/observation). Workers: scope='stage' only.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "object" },
        keys: { type: "array", items: { type: "string" } },
        body: { type: "string" },
        target_agents: { type: "array", items: { type: "string" } },
        scope: { type: "string", enum: ["project", "stage", "session"] },
        scope_ref: { type: "string" },
        expires_at: { type: "string" },
        ttl_ms: { type: "number" },
        survive_compaction: { type: "boolean" },
        source_ref: { type: "object" },
        reason: { type: "string" },
      },
      required: ["topic", "body", "scope", "reason"],
    },
  },
  {
    name: "update_memory",
    description: "Update memory fields. Workers: scope='stage' only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        keys: { type: "array", items: { type: "string" } },
        target_agents: { type: "array", items: { type: "string" } },
        expires_at: { type: "string" },
        ttl_ms: { type: "number" },
        reason: { type: "string" },
      },
      required: ["id", "reason"],
    },
  },
  {
    name: "supersede_memory",
    description: "Replace an active memory record. Roles: Pl/Mg/In.",
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
    name: "archive_memory",
    description: "Mark a memory archived. Roles: Pl/Mg/In.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, reason: { type: "string" } },
      required: ["id", "reason"],
    },
  },
  {
    name: "delete_memory",
    description: "Hard-delete a memory record. Roles: Pl/Mg/In.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, reason: { type: "string" } },
      required: ["id", "reason"],
    },
  },
  {
    name: "list_memories",
    description: "List memory records, filtered by scope/topic_domain/age.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["project", "stage", "session"] },
        topic_domain: { type: "string" },
        include_archived: { type: "boolean" },
        older_than_days: { type: "number" },
      },
    },
  },
  {
    name: "get_memory",
    description: "Get a memory by id or topic (walks supersession chain to head).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, topic: { type: "object" } },
    },
  },
  {
    name: "search_memories",
    description: "Full-text search active memories. Scored 3·topic + 2·keys + 1·body.",
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
  if (!canCall(role, op, "memory")) {
    throw new KnowledgeStoreError("UNAUTHORIZED_ROLE", "role=" + role + " cannot " + op + " memory");
  }
}

function gateScope(
  role: KnowledgeAgentRole,
  op: "create" | "supersede",
  scope: KnowledgeScope,
  scope_ref: string | undefined,
  ctx: { stageId?: string; channelId?: string },
) {
  const r = checkScope(role, op, "memory", scope, scope_ref, ctx);
  if (!r.ok) {
    throw new KnowledgeStoreError("UNAUTHORIZED_SCOPE", r.reason);
  }
}

export function makeKnowledgeMemoryHandler(store: KnowledgeStore): InProcessToolHandler {
  return async (toolName, args, ctx) => {
    if (!validateCtx(ctx)) {
      return err("UNAUTHORIZED_ROLE", "ToolCallContext required for knowledge ops");
    }
    const role = resolveRole(ctx.role);
    const author = authorOf(ctx);
    try {
      switch (toolName) {
        case "create_memory": {
          gateRole(role, "create");
          const scope = args.scope as KnowledgeScope;
          const scope_ref = args.scope_ref !== undefined ? String(args.scope_ref) : undefined;
          gateScope(role, "create", scope, scope_ref, { stageId: ctx.stageId, channelId: ctx.channelId });
          const result = await createMemory(store, {
            topic: args.topic as { domain: string; subject: string; aspect?: string },
            keys: (args.keys as string[] | undefined) ?? [],
            body: String(args.body),
            target_agents: (args.target_agents as KnowledgeAgentRole[] | undefined) ?? [],
            scope,
            ...(scope_ref ? { scope_ref } : {}),
            ...(args.expires_at !== undefined ? { expires_at: String(args.expires_at) } : {}),
            ...(args.ttl_ms !== undefined ? { ttl_ms: Number(args.ttl_ms) } : {}),
            ...(args.survive_compaction !== undefined ? { survive_compaction: Boolean(args.survive_compaction) } : {}),
            ...(args.source_ref !== undefined
              ? { source_ref: args.source_ref as { kind: "inspection" | "task_report" | "stage_summary"; id: string } }
              : {}),
            reason: String(args.reason),
          }, author);
          return ok(result);
        }
        case "update_memory": {
          gateRole(role, "create"); // update follows create per §F
          // Worker (Y†) scope preflight: pull the prior record and gate on its scope.
          const prior = getRecord(store.sidecar, String(args.id));
          if (!prior || prior.kind !== "memory") {
            return err("NOT_FOUND", "memory " + String(args.id) + " not found");
          }
          gateScope(
            role,
            "create",
            prior.scope as KnowledgeScope,
            prior.scope_ref ?? undefined,
            { stageId: ctx.stageId, channelId: ctx.channelId },
          );
          const result = await updateMemory(store, {
            id: String(args.id),
            ...(args.body !== undefined ? { body: String(args.body) } : {}),
            ...(args.keys !== undefined ? { keys: args.keys as string[] } : {}),
            ...(args.target_agents !== undefined ? { target_agents: args.target_agents as KnowledgeAgentRole[] } : {}),
            ...(args.expires_at !== undefined ? { expires_at: String(args.expires_at) } : {}),
            ...(args.ttl_ms !== undefined ? { ttl_ms: Number(args.ttl_ms) } : {}),
            reason: String(args.reason),
          }, author);
          return ok(result);
        }
        case "supersede_memory": {
          gateRole(role, "supersede");
          const nr = (args.new_record ?? {}) as Record<string, unknown>;
          const newScope = nr.scope as KnowledgeScope;
          const newScopeRef = nr.scope_ref !== undefined ? String(nr.scope_ref) : undefined;
          gateScope(role, "supersede", newScope, newScopeRef, { stageId: ctx.stageId, channelId: ctx.channelId });
          const result = await supersedeMemory(store, {
            old_id: String(args.old_id),
            new_record: {
              topic: nr.topic as { domain: string; subject: string; aspect?: string },
              keys: (nr.keys as string[] | undefined) ?? [],
              body: String(nr.body),
              target_agents: (nr.target_agents as KnowledgeAgentRole[] | undefined) ?? [],
              scope: newScope,
              ...(newScopeRef ? { scope_ref: newScopeRef } : {}),
              ...(nr.expires_at !== undefined ? { expires_at: String(nr.expires_at) } : {}),
              ...(nr.ttl_ms !== undefined ? { ttl_ms: Number(nr.ttl_ms) } : {}),
              ...(nr.survive_compaction !== undefined ? { survive_compaction: Boolean(nr.survive_compaction) } : {}),
              ...(nr.source_ref !== undefined
                ? { source_ref: nr.source_ref as { kind: "inspection" | "task_report" | "stage_summary"; id: string } }
                : {}),
              reason: String(args.reason),
            },
            reason: String(args.reason),
          }, author);
          return ok(result);
        }
        case "archive_memory": {
          gateRole(role, "archive");
          return ok(await archiveMemory(store, String(args.id), String(args.reason), author));
        }
        case "delete_memory": {
          gateRole(role, "archive"); // delete follows archive per §F
          return ok(await deleteMemory(store, String(args.id), String(args.reason), author));
        }
        case "list_memories": {
          gateRole(role, "read");
          return ok({
            memories: await listMemories(store, {
              ...(args.scope !== undefined ? { scope: args.scope as KnowledgeScope } : {}),
              ...(args.topic_domain !== undefined ? { topic_domain: String(args.topic_domain) } : {}),
              ...(args.include_archived !== undefined ? { include_archived: Boolean(args.include_archived) } : {}),
              ...(args.older_than_days !== undefined ? { older_than_days: Number(args.older_than_days) } : {}),
            }),
          });
        }
        case "get_memory": {
          gateRole(role, "read");
          const result = await getMemory(store, {
            ...(args.id !== undefined ? { id: String(args.id) } : {}),
            ...(args.topic !== undefined ? { topic: args.topic as { domain: string; subject: string; aspect?: string } } : {}),
          });
          if (result === null) return err("NOT_FOUND", "memory not found or not active");
          return ok(result);
        }
        case "search_memories": {
          gateRole(role, "search");
          return ok(await searchMemories(
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
          return err("UNKNOWN_TOOL", "unknown memory tool: " + toolName);
      }
    } catch (e) {
      if (e instanceof KnowledgeStoreError) {
        return err(e.code, e.message);
      }
      return err("INTERNAL", e instanceof Error ? e.message : String(e));
    }
  };
}

