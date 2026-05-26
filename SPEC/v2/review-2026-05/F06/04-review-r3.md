# F06 — Review (r3)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- `F06-dispatcher-notes-sidechannel.md`
- `F06/04-review-r2.md`
- `F06/01-analysis-r1.md` (retained)
- `F06/02-design-r3.md`
- `F06/03-plan-r3.md`

## Findings

### Analysis

The retained r1 analysis remains accurate and still gives the right contract for this fix: mid-loop notes must reach the Planner without mutating tool-result content, acknowledgement must stay single-path, permanent notes must reappear after compaction, and the old marker plus `planner_pointer_pending` must be deleted rather than kept as compatibility surface.

### Design

r3 closes the specific r2 lifecycle blocker for the context-overflow / orphaned-tool-result retry path. Proposal B now explicitly requires `compact -> onContextReset -> drain -> retry router.chat` inside `callLLM`, so a note delivered before the failed provider request can be re-delivered after repair compaction. That is the right shape for the input-channel abstraction.

However, the new centralized helper sketch is not aligned with the current `BaseAgent` compaction contract. The live code does not call `compactConversation` directly from either compaction site: both top-of-`runLoop` compaction and `callLLM` repair compaction already go through `compactWithReinjection()` ([src/agents/base.ts](src/agents/base.ts#L236), [src/agents/base.ts](src/agents/base.ts#L533)). That helper is not just a thin wrapper. For Planner compaction it first runs the pre-compaction memory-write hook ([src/agents/base.ts](src/agents/base.ts#L751), [src/agents/base.ts](src/agents/base.ts#L823)), and after summarization it appends the survivor reinjection block via `buildSurvivorBlock` before replacing messages ([src/agents/base.ts](src/agents/base.ts#L820-L847)).

Proposal B's `compactNow()` sketch replaces messages with `compactConversation(...)` directly ([SPEC/v2/review-2026-05/F06/02-design-r3.md](SPEC/v2/review-2026-05/F06/02-design-r3.md#L99-L108)) and defines the compaction invariant only in terms of `compactNow()` / `drainChannels()` ([SPEC/v2/review-2026-05/F06/02-design-r3.md](SPEC/v2/review-2026-05/F06/02-design-r3.md#L120-L145)). Taken literally, that would either bypass the existing pre-compaction hook and survivor-block reinjection, or leave an implementer to reconcile two competing compaction helpers without instructions. This is a functional executability gap, not a style preference: F06 must extend the existing compaction helper semantics, not erase FR-15 / FR-16 behaviour while fixing note delivery.

The Step 6 wording is now correct. The current `create_note` response returns `id`, `urgent`, `permanent`, `path`, and the obsolete `planner_pointer_pending` field ([src/mcp/notes-server.ts](src/mcp/notes-server.ts#L37-L41)); r3 correctly says to delete only `planner_pointer_pending` and preserve the other fields.

### Plan

The plan mirrors the design gap. Step 3 instructs the implementer to add a new `compactNow()` that directly calls `compactConversation` ([SPEC/v2/review-2026-05/F06/03-plan-r3.md](SPEC/v2/review-2026-05/F06/03-plan-r3.md#L89-L99)), then says there should be no other `base.ts` change beyond that helper/drain wiring ([SPEC/v2/review-2026-05/F06/03-plan-r3.md](SPEC/v2/review-2026-05/F06/03-plan-r3.md#L147)). It must instead describe how `inputChannels` integrate with the existing `compactWithReinjection()` flow, or rename/refactor that helper while preserving its full behaviour: Planner pre-compaction hook, `compactConversation`, survivor-block append, `replaceMessages`, channel `onContextReset`, then caller-side `drainChannels()` before the next provider request.

The test plan should also pin that preservation. The new repair-compaction channel test is necessary and good, but it should be supplemented or worded so forced compaction still proves the existing survivor reinjection / pre-compaction hook behaviour is retained while channel reset and drain are added. Otherwise a regression that fixes F06 by dropping knowledge-survivor reinjection could pass the proposed channel tests.

## Required changes

1. Revise `02-design-r3.md` and `03-plan-r3.md` so the centralized compaction abstraction preserves the current `compactWithReinjection()` responsibilities: Planner pre-compaction memory hook, `compactConversation`, survivor-block reinjection, `replaceMessages`, then channel `onContextReset`. The implementation plan should say whether to extend `compactWithReinjection()` itself or rename it to the new helper, but it must not introduce a direct `compactConversation` helper that bypasses those existing behaviours.
2. Extend the BaseAgent test guidance so channel reset/drain coverage coexists with the existing compaction reinjection contract. At minimum, the forced-compaction tests should fail if survivor-block reinjection or the Planner pre-compaction hook is accidentally removed while adding `InputChannel` support.

## Strengths

- r3 correctly fixes the r2 `callLLM` retry-compaction lifecycle bug at the architectural level.
- Proposal B remains the right direction: one first-class input-channel mechanism in `BaseAgent`, no dispatcher role gate, no tool-result mutation, and no compatibility shim for the old marker.
- The `create_note` response wording is corrected and properly scoped to deleting only `planner_pointer_pending`.

VERDICT: CHANGES_REQUESTED