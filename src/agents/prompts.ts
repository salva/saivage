/**
 * Saivage — Role Prompt Loader
 *
 * Loads agent system prompts from the `prompts/` directory and applies a tiny
 * include/variable templating pass. Prompts are the authoritative source of
 * role behaviour; `src/agents/*.ts` files import only the rendered string.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { renderRosterSummary } from "./roster.js";
import { renderLocalChatCommandsTable } from "./conventions.js";

export type RolePromptName =
  | "planner"
  | "manager"
  | "coder"
  | "researcher"
  | "data-agent"
  | "reviewer"
  | "designer"
  | "inspector"
  | "chat";

const here = dirname(fileURLToPath(import.meta.url));

function resolvePromptsRoot(): string {
  const candidates = [
    resolve(here, "prompts"),
    resolve(here, "../prompts"),
    resolve(here, "../../prompts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, "shared/execution-style.md"))) {
      return candidate;
    }
  }
  throw new Error(
    `Cannot locate prompts/ directory (looked in: ${candidates.join(", ")})`,
  );
}

const PROMPTS_ROOT = resolvePromptsRoot();

const INCLUDE_RE = /\{\{>\s+([a-z0-9/_-]+)\s*\}\}/g;
const VAR_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;

function readPromptFile(relPath: string): string {
  return readFileSync(resolve(PROMPTS_ROOT, `${relPath}.md`), "utf8");
}

function substitutions(role: RolePromptName): Record<string, string> {
  // The roster summary marks the focal role; map "data-agent" to its
  // AgentRole spelling ("data_agent") for the lookup.
  const rosterRole =
    role === "data-agent" ? "data_agent" : role;
  return {
    roster_summary: renderRosterSummary(rosterRole as Parameters<typeof renderRosterSummary>[0]),
    slash_commands_table: renderLocalChatCommandsTable(),
  };
}

const cache = new Map<RolePromptName, string>();

export function loadRolePrompt(role: RolePromptName): string {
  const cached = cache.get(role);
  if (cached !== undefined) return cached;

  const raw = readPromptFile(role);
  const vars = substitutions(role);

  // First pass: expand `{{> path }}` includes.
  const withIncludes = raw.replace(INCLUDE_RE, (_, includePath: string) => {
    return readPromptFile(includePath);
  });

  // Second pass: expand `{{ var }}` references.
  const rendered = withIncludes.replace(VAR_RE, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new Error(
        `Unknown prompt variable {{ ${name} }} while rendering ${role}.md`,
      );
    }
    return value;
  });

  cache.set(role, rendered);
  return rendered;
}
