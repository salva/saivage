import type { KnowledgeStore } from "./init.js";
import { knowledgeMemoryTools, makeKnowledgeMemoryHandler } from "../mcp/knowledgeMemory.js";
import { knowledgeSkillsTools, makeKnowledgeSkillsHandler } from "../mcp/knowledgeSkills.js";
import type { McpRuntime } from "../mcp/runtime.js";

export function registerKnowledgeServices(
  mcpRuntime: McpRuntime,
  knowledge?: KnowledgeStore,
): void {
  if (!knowledge) return;

  mcpRuntime.registerInProcess("skills", knowledgeSkillsTools, makeKnowledgeSkillsHandler(knowledge));
  mcpRuntime.registerInProcess("memory", knowledgeMemoryTools, makeKnowledgeMemoryHandler(knowledge));
}
