# F06 — Review (r1)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- `F06-dispatcher-notes-sidechannel.md`
- `F06/01-analysis-r1.md`
- `F06/02-design-r1.md`
- `F06/03-plan-r1.md`

## Findings

### Analysis

The analysis is accurate and complete enough to implement from. It correctly identifies the dispatcher side-channel, the cleaner Planner injection path, the mid-loop signalling reason for the existing hack, and the lifecycle split between `peekUnacknowledgedNotes()` and `getUnacknowledgedNotes()`.

### Design

Proposal B is the right architectural direction: notes become first-class input, the dispatcher stops knowing Planner-specific note semantics, and `ToolCallResultEntry.content` can go back to meaning "what the tool returned".

However, the design does not yet make its own duplicate-suppression fix executable. It says `NoteChannel.drain()` will consult `pendingAcknowledgment` and return `null` after already-drained notes [SPEC/v2/review-2026-05/F06/02-design-r1.md](SPEC/v2/review-2026-05/F06/02-design-r1.md#L87), but `pendingAcknowledgment` is private and the current `getUnacknowledgedNotes()` only adds note IDs to that set before returning the same unacknowledged notes [src/runtime/notes.ts](src/runtime/notes.ts#L57-L75). Without an explicit `NoteManager`/`NoteChannel` change, Proposal B repeats the same note on every LLM turn until `acknowledgeNotes()` runs after `runLoop()` exits [src/agents/planner.ts](src/agents/planner.ts#L204).

Permanent notes have the same problem in a worse form. The proposed `NoteChannel` always merges `getPermanentNotes()` into every drain [SPEC/v2/review-2026-05/F06/03-plan-r1.md](SPEC/v2/review-2026-05/F06/03-plan-r1.md#L36-L41), while `getPermanentNotes()` returns all permanent notes regardless of acknowledgement state [src/runtime/notes.ts](src/runtime/notes.ts#L91-L93). In a per-turn channel this means any permanent note can be injected every LLM turn forever, and it contradicts the planned test that `drain` returns `null` after every note is already pending [SPEC/v2/review-2026-05/F06/03-plan-r1.md](SPEC/v2/review-2026-05/F06/03-plan-r1.md#L102-L105).

### Plan

Step 2 contains a factual error that would produce the duplicate-injection bug above: it states that repeated `drain()` calls return `null` once IDs are in `pendingAcknowledgment` [SPEC/v2/review-2026-05/F06/03-plan-r1.md](SPEC/v2/review-2026-05/F06/03-plan-r1.md#L46), but the current code has no such filter [src/runtime/notes.ts](src/runtime/notes.ts#L69-L75). The implementation plan must specify the actual lifecycle change, not rely on behaviour that does not exist.

Step 3 also has a compaction executability gap. The plan drains and marks notes pending immediately before the existing compaction check [SPEC/v2/review-2026-05/F06/03-plan-r1.md](SPEC/v2/review-2026-05/F06/03-plan-r1.md#L59-L66), but successful compaction replaces the entire message history with one summarizer-produced user message [src/runtime/compaction.ts](src/runtime/compaction.ts#L113-L123). That does not preserve the just-drained note as a raw user message. A note could be marked pending, summarized incompletely or omitted, and later acknowledged/deleted without the Planner ever seeing the exact injected content.

There is also a small rollback/API wording issue: the plan removes `planner_pointer_pending` from the `create_note` MCP response [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L41), so the rollback section should not claim there are no API surface changes.

## Required changes

1. Revise Proposal B and the plan to define a real one-cycle drain lifecycle. The fix must explicitly prevent repeated `drain()` output for notes already pending acknowledgement, and it must handle permanent notes without re-injecting acknowledged permanent notes on every LLM turn. Add tests for repeated drains with volatile notes, unacknowledged permanent notes, and already-acknowledged permanent notes.
2. Fix the compaction placement/visibility issue. Either drain input channels after compaction or make compaction preserve freshly drained channel messages verbatim before any note is marked pending. Add a focused test that forces compaction and verifies the Planner receives the exact channel message before acknowledgement can delete or mark the note.
3. Correct the plan's factual wording: remove the false statement that current `getUnacknowledgedNotes()` makes repeated drains return `null`, and update the rollback/API note to acknowledge the `create_note` response shape change.

## Strengths

- The issue analysis is strong and distinguishes the audit-trail problem from the valid mid-loop signalling requirement.
- The recommended direction deletes the side-channel outright instead of carrying a transitional marker.
- The test plan correctly targets marker removal, dispatcher purity, and the new channel seam; it just needs the missing lifecycle and compaction cases above.

VERDICT: CHANGES_REQUESTED