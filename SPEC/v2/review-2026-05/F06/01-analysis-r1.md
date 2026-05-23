# F06 — Analysis (r1)

## Problem restated

The dispatcher injects pending user notes into the **content string of the last `tool_result` block** of a batch via `attachPendingNotesNotice`. Concretely, when the Planner finishes processing a batch of tool calls, the dispatcher peeks the `NoteManager`, builds a `notice` object, JSON-parses the last result's content, splices a `__saivage_pending_user_notes` key into it, and re-serialises. If parsing fails it appends a `--- SAIVAGE_PENDING_USER_NOTES --- ... ---` text marker instead.

Implementation:
- Call site at end of `processToolCalls`: [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L144).
- The mutation logic: [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L302-L329) (`attachPendingNotesNotice`) and [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L331-L348) (`attachNoticeToContent`).
- `ToolCallResultEntry.content` is an unconstrained `string`: [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L51-L55).
- Result content flows verbatim into the assistant conversation as a `tool_result` block (`block.content` is the mutated string): [src/agents/base.ts](src/agents/base.ts#L324-L335).
- The same content is later surfaced to the dashboard via `getConversationSnapshot`: [src/agents/base.ts](src/agents/base.ts#L437-L449).
- A unit test pins the behaviour: [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L858-L898).

The notice exists because there is **already** a separate, "proper" injection path that lives in the Planner agent itself:
- `PlannerAgent.injectPendingNotes` runs at the top of every `run()` iteration and pushes a real `{role: "user", content: formattedNotes}` message: [src/agents/planner.ts](src/agents/planner.ts#L191-L192), [src/agents/planner.ts](src/agents/planner.ts#L253-L272).
- That path uses `NoteManager.getUnacknowledgedNotes()` (which marks notes pending) and `NoteManager.formatNotesForInjection()`: [src/runtime/notes.ts](src/runtime/notes.ts#L68-L76), [src/runtime/notes.ts](src/runtime/notes.ts#L183-L207).

The Planner's per-`run()` injection only fires between `runLoop()` invocations — i.e. when the loop exits and the outer `while(true)` in `PlannerAgent.run` iterates. Inside a single `runLoop()` the Planner can dispatch one or more child agents (Manager, Inspector) and stay in the loop for the whole batch. The dispatcher notice was added so notes that arrive **during** a long child dispatch are surfaced on the very next Planner turn instead of waiting for the loop to exit.

So today there are **two parallel channels**:
1. `PlannerAgent.injectPendingNotes()` — a clean `{role: "user"}` injection at run-loop boundaries.
2. `Dispatcher.attachPendingNotesNotice()` — a string-mutation side-channel inside tool-result content for the same Planner, used mid-loop.

Channel 2 is the leaky one.

## Actual differences (between the two channels)

| Aspect | Planner channel | Dispatcher channel |
| --- | --- | --- |
| Where the data lives | New `user` message after tool batch | Mutated `tool_result.content` string |
| Schema | Free text built from `formatNotesForInjection` | JSON object spliced into the last tool's JSON, or text marker appended |
| Marks notes pending | Yes (`getUnacknowledgedNotes`) | No (uses `peekUnacknowledgedNotes` — view-only pointer) |
| Permanent-note re-injection | Yes (merged with `getPermanentNotes`) | Not handled |
| Affects audit trail | No (separate message) | Yes (last tool's output is no longer what the tool returned) |
| Affects UI snapshot | Renders as a normal user message | Renders mutated JSON inside a `tool_result` row |
| Role-gated | Yes (`PlannerAgent` only invokes it) | Yes (`ctx.role !== "planner"` early-returns) |

The dispatcher channel was deliberately built as a **pointer-only** notice (it sets `planner_pointer_pending` on note creation, see [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L37-L43)) so that the next Planner-channel injection at the run-loop boundary remains the canonical mechanism that flips notes from "unacknowledged" to "pending → acknowledged". This split-of-duties is the only reason it doesn't actively break the lifecycle, but it is exactly what makes the design fragile: any consumer (UI, snapshot, test) that pattern-matches on `tool_result.content` must now know the magic key `__saivage_pending_user_notes` exists.

## Contract

`attachPendingNotesNotice(results, ctx)`:
- **Input**: the mutable `ToolCallResultEntry[]` returned by `processToolCalls`, plus the `AgentContext`.
- **Pre-conditions**: `ctx.role === "planner"`, `results.length > 0`, and `NoteManager.peekUnacknowledgedNotes()` is non-empty. Otherwise no-op.
- **Effect**: mutates `results[results.length - 1].content` in place by either:
  - parsing it as a JSON object and inserting `__saivage_pending_user_notes: notice`;
  - parsing it as JSON non-object and wrapping it as `{result: parsed, __saivage_pending_user_notes: notice}`;
  - on parse failure, appending a textual `--- SAIVAGE_PENDING_USER_NOTES --- … ---` block to the original string.
- **Notice shape**: `{count, urgent_count, notes: [{id, urgent, permanent, channel, created_at, path, content_preview}], instruction}`. `content_preview` truncates at 1000 chars via local `truncateNoteContent`.
- **Output**: void. The returned `DispatchResult` is otherwise unchanged.

Failure modes:
- A non-JSON local tool result (e.g. a shell-tool wrapper that just returns a raw string) silently switches to the text-marker form, producing a hybrid content payload that has no schema.
- The mutation runs after dispatch result assembly, so the **first** result in the batch is untouched. Which "last" result is mutated depends on completion order of `Promise.all` for dispatch tools (`results.push(...dispatchResults)` at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L141-L142)). For batches that mix local and dispatch calls the last entry is always a dispatch result; for local-only batches it's the last local result. Either way the choice of which tool gets its body rewritten is incidental.
- No lifecycle effect (notes are not marked acknowledged), so if the Planner does *not* react to the marker, the same notice will be re-attached on every subsequent tool batch until the run-loop iterates and the Planner-channel injection runs.

## Call sites & dependencies

Producers of `__saivage_pending_user_notes`:
- [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L302-L329) (only).

Consumers:
- The Planner LLM reads it inside `tool_result.content` — there is **no parser** anywhere in the codebase that branches on the key; the system relies on the model noticing the JSON field by convention (the `notice.instruction` string is the entire "API").
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L858-L898) asserts the JSON-splice path works.
- The dashboard renders `tool_result.content` as opaque text via [src/agents/base.ts](src/agents/base.ts#L437-L449); the marker is visible to operators but not specially formatted.
- `web/src/utils/toolFormatters.ts` and the per-tool renderers do not branch on the key.

Adjacent dependencies:
- `NoteManager` (read-only via `peekUnacknowledgedNotes`): [src/runtime/notes.ts](src/runtime/notes.ts#L78-L83).
- `AgentContext.project.paths.notes` for the directory.
- The `planner_pointer_pending: true` field returned by `create_note`: [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L37-L43) — currently a documentation-only field; the dispatcher does not consult it and creates a fresh `NoteManager` each call.

## Constraints any solution must respect

1. **Mid-loop signalling must remain possible.** Notes that the Chat agent (or `create_note` tool) writes while the Planner is awaiting a long Manager dispatch must reach the Planner on its very next LLM turn, not only after the next `runLoop()` exit. Today the dispatcher notice is what guarantees that; any replacement must preserve it.
2. **Tool-result content must remain "what the tool returned".** The audit trail, dashboard rendering, snapshot logic, and any future tool-result schema enforcement all depend on this invariant. The fix must not contaminate that string.
3. **Single acknowledgement path.** The `pendingAcknowledgment` set in `NoteManager` is flipped by `getUnacknowledgedNotes` and drained by `acknowledgeNotes` (called in `PlannerAgent.run` after every `runLoop` exit at [src/agents/planner.ts](src/agents/planner.ts#L207)). Any new injection point that is intended to *deliver* notes (not just pointer-notify) must use `getUnacknowledgedNotes`, not `peekUnacknowledgedNotes`, and acknowledgement must still fire exactly once per cycle. Avoid introducing a second acknowledgement path that races with the existing one.
4. **Permanent notes** must still be re-injected after compaction. Today that is done by the Planner channel alone.
5. **Role-gating must remain the Planner.** No other agent today consumes notes; the Manager/Coder/etc. must not start receiving user-note injections as a side effect of refactoring.
6. **Out-of-scope boundary:** `src/skills/` and `SPEC/v2/skills-memory/` are owned by another reviewer per `_LOOP-CONVENTIONS.md`. The `NoteManager` is in `src/runtime/`, which is in scope.
7. **No backward compatibility.** Per project guideline 1, the JSON marker key, the text-marker form, and the `planner_pointer_pending` field on `create_note`'s return value must all be deleted, not soft-migrated. Existing tests that lock in the marker shape must be replaced, not preserved.
8. **Sync `fs` budget** (cross-cutting with F22): the current side-channel reads the notes directory on every tool batch. Any replacement should poll the notes directory at most once per LLM turn, not once per tool, so it does not multiply the disk-I/O footprint that F22 is trying to bound.
