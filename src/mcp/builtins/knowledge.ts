import type { KnowledgeStore } from "../../knowledge/init.js";
import { knowledgeMemoryTools, makeKnowledgeMemoryHandler } from "../knowledgeMemory.js";
import { knowledgeSkillsTools, makeKnowledgeSkillsHandler } from "../knowledgeSkills.js";
import type { McpRuntime } from "../runtime.js";

export function registerKnowledgeServices(
  mcpRuntime: McpRuntime,
  knowledge?: KnowledgeStore,
): void {
  if (!knowledge) return;

  mcpRuntime.registerInProcess("skills", knowledgeSkillsTools, makeKnowledgeSkillsHandler(knowledge));
  mcpRuntime.registerInProcess("memory", knowledgeMemoryTools, makeKnowledgeMemoryHandler(knowledge));
}
