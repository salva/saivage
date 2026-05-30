# F31 — `BaseAgentConfig.systemPrompt` JSDoc promises a `prompts/<role>.md` layout that does not exist

**Category**: documentation-mismatch
**Severity**: low
**Transversality**: local

## Summary

The `BaseAgentConfig.systemPrompt` field carries an explicit JSDoc comment "System prompt (from prompts/<role>.md)" — but there is no `prompts/` directory in the repository. Every agent passes a TS string literal instead. The comment is the only trace of an intended-but-never-built feature.

## Evidence

- The JSDoc: [src/agents/base.ts](src/agents/base.ts#L107-L108).
- Each agent passes a string literal: [src/agents/planner.ts](src/agents/planner.ts#L194-L209), [src/agents/manager.ts](src/agents/manager.ts#L264-L278), [src/agents/coder.ts](src/agents/coder.ts#L139-L155), etc.
- There is no `prompts/` folder under the repo root.

## Why this matters

A stale promise in a public type is worse than no promise — it tells readers "look for prompts in `prompts/<role>.md`" when they should look in `src/agents/<role>.ts`. Either implement the loader (which is the design F18 already argues for) or remove the misleading comment.

## Related

- F18 (system prompt bloat — the missing loader is the unbuilt half of that design)
