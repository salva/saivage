# G09 — Planner uses regex-on-LLM-text to detect `PLAN_COMPLETE` termination

**Subsystem:** src/agents/
**Category:** architecture / control-protocol
**Severity:** medium
**Transversality:** module (single regex), but a recurring anti-pattern in this codebase

## Summary

The Planner decides whether the project is complete by regex-matching its own free-text final response: `/^\s*PLAN_COMPLETE\s*$/m.test(text)`. There is no tool, no structured signal, and no machine-checkable protocol — completion is "the model wrote the right magic string on its own line". Compaction can drop that line; the nudge loop can override it; a model that paraphrases or wraps the marker in punctuation will trigger an infinite nudge cycle until `MAX_NUDGES=15` and then a stuck-agent failure. The text-protocol style does not belong in v2 alongside structured tool calls everywhere else.

## Evidence

[src/agents/planner.ts](src/agents/planner.ts#L91-L93):

```ts
// Only accept completion if planner explicitly says PLAN_COMPLETE
// on its own line — not just as part of a sentence
if (/^\s*PLAN_COMPLETE\s*$/m.test(text)) {
  return { kind: "success", data: { summary: "PLAN_COMPLETE" } };
}
```

The matching prompt instruction lives in the user-facing message constructor at [src/agents/planner.ts](src/agents/planner.ts#L172): *`Only respond with "PLAN_COMPLETE" when objectives are verified ...`*. So the contract is:

1. Planner emits free text on its final assistant turn.
2. Regex over that text decides whether the agent succeeded or got nudged.

By contrast, *every other* terminal signal in v2 is structured: Manager returns a `StageSummary` JSON, Workers return `TaskReport` JSON, Inspector returns `InspectionReport` JSON (all parsed via `parseLlmJsonAs` against Zod schemas). The Planner is the lone exception.

Failure modes already implicit in the code:

- Models that wrap the marker in markdown emphasis (`**PLAN_COMPLETE**`) fail the regex.
- Models that explain *before* the marker on the same line (`Objectives met. PLAN_COMPLETE`) fail the `^\s*...\s*$` anchors.
- Compaction (G07) can summarize the assistant's final turn and drop the marker without the loop knowing.
- The nudge counter caps at 15 ([src/agents/planner.ts](src/agents/planner.ts#L99)); after that the planner returns a failure even though the *project* may be complete and the model just couldn't satisfy the regex.

There is no telemetry distinguishing "model said completion but used wrong wording" from "model didn't believe completion was reached".

## Why this matters

- A free-text termination protocol is a regression versus the otherwise-structured v2 contract. It also undermines round-1 work on Plan MCP tools — there's already a tool surface that *could* carry an explicit `plan_complete()` (or `plan_mark_complete(reason)`) call.
- The nudge prompt (lines 105–112) is a 7-line block of instructions written to recover from a missed marker; this is "compensating for a fragile protocol" rather than fixing the protocol.
- It also leaks framework concerns (the magic string) into prompt content, which prevents future prompt redesign without coordinated regex updates.

## Rough remediation direction

Two stages:

1. **Add a structured tool**, e.g. `plan_complete(reason: string)` in the Plan MCP. Planner success path becomes: did the most recent assistant turn include a `plan_complete` tool_use whose result was OK? If yes → `{ kind: "success", data: { summary: reason } }`. If no → nudge as today.
2. **Migrate the prompt** from "respond with PLAN_COMPLETE" to "call plan_complete(reason)". Keep the regex as a deprecated fallback for one release (with a `log.warn` on hit), then delete.

Side benefit: the structured tool makes `PLAN_COMPLETE` a first-class event the dashboard and runtime supervisor can observe (today the dashboard has to scrape the regex from message text just like the Planner code does).

## Cross-links

- Same family as round-1 findings on Manager / Worker / Inspector structured returns — Planner is the missing piece.
- Worsens compaction risk from G07 (a compacted final turn loses the marker).
