# F14 — `ReviewerAgent` double-pushes the final assistant message

**Category**: leaky-abstraction
**Severity**: medium
**Transversality**: local

## Summary

`BaseAgent.runLoop` already pushes the final no-tool assistant response into `this.messages` before returning. `ReviewerAgent.review` then pushes it again so the reviewer can compare follow-up reviews against earlier text. The result is that the reviewer's conversation history contains every final answer twice from the second review onward.

## Evidence

- `runLoop` pushes the final assistant message and only then returns the text: [src/agents/base.ts](src/agents/base.ts#L264-L286).
- Reviewer pushes again after `runLoop` returns: [src/agents/reviewer.ts](src/agents/reviewer.ts#L195-L205) (the `this.messages.push({ role: "assistant", content: text })` block).
- The planner's nudge path has the same problem (less critical because it's only on the error path): [src/agents/planner.ts](src/agents/planner.ts#L258-L259).

## Why this matters

The reviewer is the only multi-turn worker. Each duplicated assistant message inflates the prompt by the full review text every dispatch, accelerating compaction and biasing the reviewer toward repeating itself ("as I said before, ..."). The fact that BaseAgent owns the message log but subclasses occasionally reach in is the root design smell — BaseAgent should expose `appendUserMessage(text)` for the inbound side and never let subclasses touch `messages` directly.

## Related

- F09 (worker duplication generally)
