/**
 * Saivage — F18: prompt loader tests.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRolePrompt, type RolePromptName } from "./prompts.js";
import { LOCAL_CHAT_COMMANDS } from "../chat/localCommandRegistry.js";

const here = dirname(fileURLToPath(import.meta.url));

const ROLES: { role: RolePromptName; marker: string }[] = [
  { role: "planner",    marker: "# Planner" },
  { role: "manager",    marker: "# Manager" },
  { role: "coder",      marker: "# Coder" },
  { role: "researcher", marker: "# Researcher" },
  { role: "data-agent", marker: "# Data Agent" },
  { role: "reviewer",   marker: "# Reviewer" },
  { role: "designer",   marker: "# Designer" },
  { role: "critic",     marker: "# Critic" },
  { role: "inspector",  marker: "# Inspector" },
  { role: "chat",       marker: "# Chat" },
];

describe("loadRolePrompt", () => {
  for (const { role, marker } of ROLES) {
    it(`returns a non-empty prompt for ${role} containing its title`, () => {
      const text = loadRolePrompt(role);
      expect(text.length).toBeGreaterThan(200);
      expect(text).toContain(marker);
    });

    it(`expands all template markers for ${role}`, () => {
      const text = loadRolePrompt(role);
      expect(text).not.toMatch(/\{\{>\s+/);
      expect(text).not.toMatch(/\{\{\s*[a-z0-9_]+\s*\}\}/);
    });

    it(`includes the Visible Execution Style block in ${role}`, () => {
      const text = loadRolePrompt(role);
      expect(text).toContain("Visible Execution Style");
    });
  }

  it("expands the slash command table in the chat prompt", () => {
    const text = loadRolePrompt("chat");
    for (const cmd of LOCAL_CHAT_COMMANDS) {
      expect(text).toContain(cmd.name);
    }
    expect(text).not.toContain("{{slash_commands_table}}");
  });

  it("has no remaining `*_PROMPT = `` template literals in src/agents/*.ts", () => {
    const agentsDir = resolve(here);
    const files = readdirSync(agentsDir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "prompts.ts",
    );
    const offenders: string[] = [];
    for (const f of files) {
      const body = readFileSync(resolve(agentsDir, f), "utf8");
      if (/_PROMPT\s*=\s*`/.test(body)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("manager prompt documents the rag retrieval-miss → run_librarian routing rule", () => {
    const text = loadRolePrompt("manager");
    expect(text).toContain("run_librarian");
    expect(text).toContain("objective");
    expect(text).toContain('"rag retrieval miss:"');
  });
});
