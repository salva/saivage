# F18 — Multi-hundred-line system prompts embedded as string literals in TS source

**Category**: bad-design
**Severity**: medium
**Transversality**: architectural

## Summary

Seven agents each declare a multi-hundred-line system prompt as a template-literal constant at the top of their TS file. The planner prompt alone is over a hundred lines of carefully tuned guidance; the manager, reviewer, inspector, chat, designer, and worker prompts add up to roughly the same again. Iterating on prompts therefore requires (a) editing TS, (b) re-running `tsc`, (c) restarting the runtime, and (d) escaping backticks for every JSON example inside the prompt.

## Evidence

- `PLANNER_PROMPT` (~100 lines): [src/agents/planner.ts](src/agents/planner.ts#L19-L120).
- `MANAGER_PROMPT` (~200 lines incl. JSON examples): [src/agents/manager.ts](src/agents/manager.ts#L22-L260).
- `CODER_PROMPT`: [src/agents/coder.ts](src/agents/coder.ts#L21-L130).
- `RESEARCHER_PROMPT`: [src/agents/researcher.ts](src/agents/researcher.ts#L20-L190).
- `REVIEWER_PROMPT`: [src/agents/reviewer.ts](src/agents/reviewer.ts#L20-L130).
- `INSPECTOR_PROMPT`: [src/agents/inspector.ts](src/agents/inspector.ts#L20-L200).
- `CHAT_PROMPT`: [src/agents/chat.ts](src/agents/chat.ts#L20-L260).
- `DESIGNER_PROMPT` (orphan): [src/agents/designer.ts](src/agents/designer.ts#L19-L140).

## Why this matters

Prompt iteration is the primary lever for agent quality, and currently it's the slowest thing to change. Externalising prompts into `prompts/<role>.md` files (the runtime even has a comment about this — see `BaseAgentConfig.systemPrompt` description: "from prompts/<role>.md" at [src/agents/base.ts](src/agents/base.ts#L107-L108)) would let operators ship prompt tweaks without rebuilds and would make the agents file shrink to logic-only. The fact that this is already documented as the intended layout — but not implemented — makes it half-implemented (see F31).

## Related

- F09 (worker duplication is amplified by per-file prompts)
- F31 (`BaseAgentConfig.systemPrompt` comment promises files that don't exist)
