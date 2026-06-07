/**
 * Saivage — MCP `skills` service handler (M2 / WI-07).
 *
 * Thin adapter (§C.1) over `src/knowledge/lifecycle.ts`. The model-visible
 * skill surface is read-only: call `skill` without a name to list skills or
 * with a name to read the matching active skill.
 *   1. asserts `ctx` is present
 *   2. resolves the agent role + `op` from the tool name
 *   3. calls `canCall(role, op, "skill")` → `UNAUTHORIZED_ROLE`
 *   4. for writes, calls lifecycle helpers which enforce reason,
 *      scope-path coherence, secret/blocked-path guards, atomic IO,
 *      audit + index rebuild (§C.3 step order).
 *   5. for reads, returns redacted view via `redactForRead`.
 *
 * Source of truth: docs/internals/mcp/services.md §6 (Skills tool surface)
 * and docs/internals/knowledge/skills-and-memory.md (concepts + ACL).
 */

import type { ToolEntry } from "./types.js";
import type { InProcessToolHandler } from "./runtime.js";
import { canCall } from "../knowledge/permissions.js";
import { KnowledgeStoreError } from "../knowledge/store.js";
import type { KnowledgeStore } from "../knowledge/init.js";
import {
  listSkills,
  readSkillById,
} from "../knowledge/lifecycle.js";
import {
  KnowledgeAgentRoleSchema,
  type KnowledgeAgentRole,
} from "../knowledge/types.js";

export const knowledgeSkillsTools: ToolEntry[] = [
  {
    name: "skill",
    description: "List available skills or load one skill by name. Skills are workspace files/runtime knowledge; this tool does not mutate them.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name to load. Omit to list available skills." },
      },
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

function ok(content: unknown) { return { content, isError: false }; }
function err(code: string, message: string) {
  return { content: { error: { code, message } }, isError: true };
}

function gateRead(role: KnowledgeAgentRole) {
  if (!canCall(role, "read", "skill")) {
    throw new KnowledgeStoreError("UNAUTHORIZED_ROLE", "role=" + role + " cannot read skill");
  }
}

export function makeKnowledgeSkillsHandler(store: KnowledgeStore): InProcessToolHandler {
  return async (toolName, args, ctx) => {
    if (!validateCtx(ctx)) {
      return err("UNAUTHORIZED_ROLE", "ToolCallContext required for knowledge ops");
    }
    const role = resolveRole(ctx.role);
    try {
      switch (toolName) {
        case "skill": {
          gateRead(role);
          const skills = await listSkills(store);
          const name = typeof args.name === "string" ? args.name.trim() : "";
          if (!name) return ok({ skills });
          const match = skills.find((s) => s.name === name && s.status === "active");
          if (!match) throw new KnowledgeStoreError("NOT_FOUND", "skill " + name + " not found");
          return ok(await readSkillById(store, match.id));
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
