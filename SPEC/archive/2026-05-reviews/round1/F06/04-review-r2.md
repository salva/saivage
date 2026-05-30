# F06 — Review (r2)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- `F06-dispatcher-notes-sidechannel.md`
- `F06/04-review-r1.md`
- `F06/01-analysis-r1.md` (retained)
- `F06/02-design-r2.md`
- `F06/03-plan-r2.md`

## Findings

### Analysis

The retained r1 analysis remains accurate. It correctly describes the dispatcher side-channel, why the existing Planner injection path is cleaner but insufficient for mid-loop notes, and the constraints around a single acknowledgement path, permanent-note re-injection, Planner-only role gating, and deleting the marker rather than preserving compatibility.

### Design

r2 resolves the main lifecycle objection from r1 for the normal per-turn path. The `delivered` set, `pullDeliverables()`, `resetDelivered()`, and permanent-note semantics are concrete enough to implement, and the design now prevents repeated drain output between compactions.

The remaining blocker is that the compaction invariant covers only the top-of-`runLoop` compaction block. Proposal B says channels are drained once per LLM turn after compaction and before `callLLM` [SPEC/v2/review-2026-05/F06/02-design-r2.md](SPEC/v2/review-2026-05/F06/02-design-r2.md#L65), then restates the invariant as `compact -> onContextReset -> drain -> callLLM` [SPEC/v2/review-2026-05/F06/02-design-r2.md](SPEC/v2/review-2026-05/F06/02-design-r2.md#L129-L135). But `BaseAgent.callLLM()` has a second compaction path for context-overflow and orphaned-tool-result repair: after the channel-drained note has already been pushed, a failed provider request can call `compactConversation`, replace `this.messages`, and retry inside the same `callLLM()` invocation [src/agents/base.ts](src/agents/base.ts#L518-L543). That path neither calls `onContextReset()` nor re-runs `drain()` before retrying, so a freshly delivered note can still be compacted away before the model receives the exact injected user message. This is the same class of compaction/visibility bug as r1, just in the retry compaction site rather than the pre-call `shouldCompact` site.

### Plan

The ordered plan mirrors the design gap. Step 3 wires `onContextReset()` only after the top-level `replaceMessages(await compactConversation(...))` block [SPEC/v2/review-2026-05/F06/03-plan-r2.md](SPEC/v2/review-2026-05/F06/03-plan-r2.md#L107-L123), and the tests only assert the normal compact -> reset -> drain -> call order [SPEC/v2/review-2026-05/F06/03-plan-r2.md](SPEC/v2/review-2026-05/F06/03-plan-r2.md#L171-L174). The implementation plan must also cover the `callLLM()` repair compaction path and add a focused test where a channel drains a note, the first model request throws a context-overflow or orphaned-tool-result error, compaction runs, and the retry request receives the exact channel message after reset/re-drain.

There is one factual wording error in Step 6: the existing `create_note` response keeps `id`, not `note_id` [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L36-L41). The plan currently says to keep `note_id` and `path` [SPEC/v2/review-2026-05/F06/03-plan-r2.md](SPEC/v2/review-2026-05/F06/03-plan-r2.md#L156), which could accidentally introduce an unrelated response-field rename.

## Required changes

1. Revise Proposal B and the plan so the channel reset/drain lifecycle covers every `compactConversation` call site in `BaseAgent`, including the context-overflow/orphaned-tool-result repair path inside `callLLM()`. Specify whether this is done by centralizing compaction in a helper that resets channels and re-drains before retry, or by making repair compaction return control to `runLoop` before the next provider request. Add a focused regression test for that path.
2. Correct the `create_note` response wording in Step 6 from `note_id` to the actual `id` field, unless the writer intentionally wants to rename the API field and plans the corresponding tests and consumers. The simpler F06-scoped change is to delete only `planner_pointer_pending`.

## Strengths

- The r2 lifecycle model is a substantial improvement over r1 and directly handles repeated drains and permanent-note re-injection between compactions.
- Proposal B still chooses the cleaner architecture: one input-channel mechanism in `BaseAgent`, no dispatcher role gate, no tool-result mutation, and no compatibility shim for the old marker.
- The test plan now covers the original duplicate-injection and permanent-note cases well; it just needs the retry-compaction case added.

VERDICT: CHANGES_REQUESTED