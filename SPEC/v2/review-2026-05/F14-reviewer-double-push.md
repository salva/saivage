# F14 — `ReviewerAgent` double-pushes the final assistant message

**Category**: leaky-abstraction
**Severity**: medium
**Transversality**: local

**Status**: landed in working tree (pre-commit). The reviewer half was superseded by F09's `WorkerAgent` rewrite of `ReviewerAgent.review` (no more `this.messages.push` after `runLoop`); the planner one-line nudge fix landed in [src/agents/planner.ts](src/agents/planner.ts#L228). Regression tests live in `src/agents/agents.test.ts` (reviewer) and `src/agents/planner.nudge.test.ts` (planner).

## Evidence

- `runLoop` pushes the final assistant message and only then returns the text: [src/agents/base.ts](src/agents/base.ts#L264-L286).
- Reviewer double-push: superseded by F09's `ReviewerAgent` rewrite (history retained for review trail).
- The planner's nudge path had the same problem; fix landed at [src/agents/planner.ts](src/agents/planner.ts#L228).

## Why this matters

The reviewer is the only multi-turn worker. Each duplicated assistant message inflates the prompt by the full review text every dispatch, accelerating compaction and biasing the reviewer toward repeating itself ("as I said before, ..."). The fact that BaseAgent owns the message log but subclasses occasionally reach in is the root design smell — BaseAgent should expose `appendUserMessage(text)` for the inbound side and never let subclasses touch `messages` directly.

## Related

- F09 (worker duplication generally)
