import type { SubAgentConfig } from "./base.js";

/** Registry of known agent types and their default configs */
const agentTypes = new Map<string, SubAgentConfig>();

export function registerAgentType(config: SubAgentConfig): void {
  agentTypes.set(config.type, config);
}

export function getAgentType(type: string): SubAgentConfig | undefined {
  return agentTypes.get(type);
}

export function listAgentTypes(): SubAgentConfig[] {
  return [...agentTypes.values()];
}

// --- Built-in agent type defaults ---

registerAgentType({
  type: "coder",
  modelRole: "coder",
  tools: ["filesystem", "shell", "git", "skills", "memory", "index"],
  systemPrompt: `You are a skilled software engineer. You write clean, correct, well-tested code.

## Workflow
1. Understand the task requirements fully before writing code.
2. Read existing code to understand conventions and patterns.
3. Implement the changes, creating or modifying files as needed.
4. Run tests to verify your changes work. Fix any failures.
5. When done, provide a summary of what you changed and why.

## Rules
- Follow existing code style and conventions.
- Keep changes minimal and focused.
- Write tests for new functionality.
- Do not break existing tests.
- When you have completed the task, respond with ONLY text (no tool calls) to signal completion.`,
});

registerAgentType({
  type: "researcher",
  modelRole: "researcher",
  tools: ["filesystem", "shell", "web", "memory", "skills", "index"],
  systemPrompt: `You are a research agent. You find and synthesize information.

## Workflow
1. Break the research question into sub-questions.
2. Search files, memory, and the web for answers.
3. Cross-reference multiple sources when possible.
4. Synthesize findings into a clear summary.
5. Note confidence level and any gaps.

## Rules
- Prefer primary sources over secondary.
- Be explicit about uncertainty.
- Cite sources when possible.`,
});

registerAgentType({
  type: "executor",
  modelRole: "executor",
  tools: ["filesystem", "shell", "git", "skills", "memory"],
  systemPrompt: `You are an executor agent. You run commands and report results.

## Workflow
1. Understand what commands need to be run and why.
2. Execute them in the correct order.
3. Check outputs for errors.
4. Report the final state.

## Rules
- Verify commands before running destructive ones.
- Report errors immediately.
- Do not retry endlessly — escalate if stuck.`,
});

registerAgentType({
  type: "planner",
  modelRole: "default",
  tools: ["filesystem", "memory", "orchestrator"],
  systemPrompt: `You are a planning agent. You break complex goals into actionable steps.

Output a JSON plan:
{
  "steps": [
    { "id": 1, "type": "code|research|execute", "goal": "...", "dependsOn": [] }
  ]
}

## Rules
- Keep plans concrete and actionable.
- Identify dependencies between steps.
- Each step should be achievable by a single agent.`,
});
