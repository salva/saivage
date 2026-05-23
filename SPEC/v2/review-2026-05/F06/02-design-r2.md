# F06 — Design (r2)

## Changes from r1

- Proposal B is reworked to define a real one-cycle drain lifecycle in `NoteManager`. The r1 text claimed `NoteChannel.drain()` would "consult `pendingAcknowledgment` and return `null`" without specifying any change to `NoteManager`; the current `getUnacknowledgedNotes()` does not filter by that set ([src/runtime/notes.ts](src/runtime/notes.ts#L68-L75)). r2 introduces an explicit per-context `delivered` set and a single `pullDeliverables()` method that filters and marks atomically.
- Permanent notes are no longer pulled by a parallel `getPermanentNotes()` call inside the channel. They participate in the same `delivered` lifecycle. They re-appear only after compaction, via an explicit `onContextReset()` hook on `InputChannel` that compaction is required to fire.
- The mid-loop hook placement moves from "before `shouldCompact`" to "after the compaction block, before `callLLM`". This eliminates the r1 hazard where a note could be marked pending and then immediately discarded by `compactConversation` replacing the entire history with a summarizer message ([src/runtime/compaction.ts](src/runtime/compaction.ts#L113-L123)).
- Proposal A inherits the same lifecycle requirement: it is rewritten so the new `BaseAgent` mid-loop hook uses the same `pullDeliverables()` / post-compaction ordering instead of an undefined "reuse `pendingAcknowledgment`" sentence.
- The `NoteChannel.drain()` test list is extended to cover the three lifecycle cases the r1 reviewer called out: repeated drains with volatile notes, drains with unacknowledged permanent notes, drains with already-acknowledged permanent notes.

The two-proposal structure and the recommendation (B) are unchanged. Both proposals still delete `attachPendingNotesNotice`, the `__saivage_pending_user_notes` JSON key, the text-marker fallback, the `planner_pointer_pending` field on `create_note`'s return, and the r1 runtime test that pins the side-channel shape ([src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L853-L898)).

---

## Proposal A — focused fix: emit a separate `user` message instead of mutating the tool result

### Scope (files touched)

- [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts) — replace `attachPendingNotesNotice` and `attachNoticeToContent`; widen `DispatchResult` with an optional `pendingNotesNotice` field populated from a new `NoteManager` method (see lifecycle below).
- [src/agents/base.ts](src/agents/base.ts) — after pushing the `tool_result` user message at [src/agents/base.ts](src/agents/base.ts#L323-L335), if `dispatchResult.pendingNotesNotice` is non-null push a second `{role: "user", content: <formatted text>}` message. Crucially the dispatcher call already runs *after* the compaction check at the top of `runLoop` ([src/agents/base.ts](src/agents/base.ts#L222-L240)), so the new injection is automatically post-compaction in this path.
- [src/runtime/notes.ts](src/runtime/notes.ts) — change the lifecycle as described in "Shared lifecycle change" below. Add a `formatPendingNotice(notes: UserNote[])` helper next to `formatNotesForInjection`.
- [src/runtime/compaction.ts](src/runtime/compaction.ts) — `compactConversation` now returns its existing replacement history *and* signals to the caller that a context reset occurred. Concretely, `BaseAgent` calls `noteManager.resetDelivered()` (or the equivalent on whatever NoteManager-shaped object Proposal A wires in) immediately after `compactConversation` succeeds. In Proposal A this means widening `BaseAgentConfig` with an optional `onContextReset?: () => void` callback that the Planner registers.
- [src/mcp/notes-server.ts](src/mcp/notes-server.ts) — drop the `planner_pointer_pending` field from `create_note`'s return at [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L37-L43). API surface change is acknowledged.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts) — delete the `"Dispatcher pending note pointers"` describe block at [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L853-L898) and replace with tests that assert (a) the dispatcher returns `pendingNotesNotice` on `DispatchResult` and does not mutate any `ToolCallResultEntry.content`, (b) the new lifecycle (see test list in the shared section).

### What gets added

- `DispatchResult.pendingNotesNotice?: { count: number; urgent_count: number; notes: PendingNoteRef[] }`.
- `formatPendingNotice(notes: UserNote[]): string` in `notes.ts`.
- New `NoteManager.pullDeliverables(): UserNote[]` (see shared lifecycle change below).
- `BaseAgentConfig.onContextReset?: () => void` callback, invoked after a successful `compactConversation`.

### What gets removed

- `Dispatcher.attachPendingNotesNotice` (entire method), `attachNoticeToContent`, `truncateNoteContent`.
- `__saivage_pending_user_notes` JSON key and `--- SAIVAGE_PENDING_USER_NOTES ---` text marker (every grep hit).
- `planner_pointer_pending: true` on `create_note`'s return shape.
- The `NoteManager.getUnacknowledgedNotes()` method (replaced by `pullDeliverables`). `peekUnacknowledgedNotes` stays — it has read-only consumers in dashboards/tests.
- The r1 dispatcher-side-channel runtime test.

### Risk

- Low for the dispatcher rewrite.
- Medium for the compaction-reset callback: `BaseAgentConfig` gains a field that only Planner uses today. This is the precise duplication Proposal B avoids.

### What it enables

- Future schema enforcement of `ToolCallResultEntry.content`.

### What it forbids

- Re-introducing dispatcher tool-result mutation.
- Re-introducing parallel polling sites for the same `NoteManager`.

### Recommendation note

A still leaves two code paths consuming notes (`PlannerAgent.injectPendingNotes` at the run-loop boundary and `BaseAgent` mid-loop) plus the new compaction-reset callback. The lifecycle now has to be correct in two places. Prefer B.

---

## Proposal B — level-up: notes are a first-class channel; one polling point in `BaseAgent`

### Scope (files touched)

- [src/agents/base.ts](src/agents/base.ts) — add a `NoteChannel` (more generally any `InputChannel`) hook consulted **once per LLM turn, after compaction, before `callLLM`** ([src/agents/base.ts](src/agents/base.ts#L222-L246)). Also call `channel.onContextReset()` immediately after a successful `compactConversation`.
- [src/agents/planner.ts](src/agents/planner.ts) — delete `injectPendingNotes` ([src/agents/planner.ts](src/agents/planner.ts#L253-L272)) and its call at [src/agents/planner.ts](src/agents/planner.ts#L191-L192). Configure the Planner with `inputChannels: [new NoteChannel(noteManager)]`. Keep `this.noteManager.acknowledgeNotes()` at [src/agents/planner.ts](src/agents/planner.ts#L207); it still flushes the per-cycle acknowledgements on every `runLoop` exit.
- [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts) — delete `attachPendingNotesNotice` ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L302-L329)), `attachNoticeToContent` ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L331-L348)), `truncateNoteContent`, the post-dispatch call at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L144), and the `NoteManager` import at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L12).
- [src/runtime/notes.ts](src/runtime/notes.ts) — change the `NoteManager` lifecycle (see "Shared lifecycle change" below). Add a new exported `NoteChannel` class implementing `InputChannel`.
- [src/agents/types.ts](src/agents/types.ts) — add a narrow `InputChannel` interface (see below). Same file already hosts agent-side type contracts.
- [src/mcp/notes-server.ts](src/mcp/notes-server.ts) — drop `planner_pointer_pending` from `create_note`'s return.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts) — replace the dispatcher side-channel test with channel-level tests (see Test list).

### What gets added

```ts
// src/agents/types.ts
export interface InputChannel {
  /** Return a single user-role message to inject before the next LLM turn, or null if nothing is pending. */
  drain(): { message: string } | null;
  /** Called by BaseAgent right after a successful compactConversation. */
  onContextReset(): void;
}
```

```ts
// src/runtime/notes.ts (new class at end of file)
export class NoteChannel implements InputChannel {
  constructor(private readonly noteManager: NoteManager) {}

  drain(): { message: string } | null {
    const notes = this.noteManager.pullDeliverables();
    if (notes.length === 0) return null;
    return { message: this.noteManager.formatNotesForInjection(notes) };
  }

  onContextReset(): void {
    this.noteManager.resetDelivered();
  }
}
```

`BaseAgentConfig.inputChannels?: InputChannel[]` (default `[]`). `BaseAgent.runLoop` runs each channel's `drain()` once per iteration after the compaction block and before `callLLM`, pushing the returned message as a real `{role: "user"}` message. After `compactConversation` resolves, `BaseAgent` calls `onContextReset()` on each channel.

### What gets removed

- `Dispatcher.attachPendingNotesNotice` and its helpers.
- `PlannerAgent.injectPendingNotes` and the call site.
- `NoteManager.getUnacknowledgedNotes()` (single caller goes away with `injectPendingNotes`).
- `NoteManager.getPermanentNotes()` (single remaining caller goes away with `injectPendingNotes`; permanent notes are now selected inside `pullDeliverables`).
- The `__saivage_pending_user_notes` JSON key, the text-marker fallback, `planner_pointer_pending`, and the dispatcher side-channel runtime test.
- The `NoteManager` import in `dispatcher.ts` and its role-gate.

### Shared lifecycle change (applies to A and B, defined here)

`NoteManager` today has one set, `pendingAcknowledgment`, which `getUnacknowledgedNotes()` only adds to (it never filters by it) and which `acknowledgeNotes()` fully clears ([src/runtime/notes.ts](src/runtime/notes.ts#L57-L75), [src/runtime/notes.ts](src/runtime/notes.ts#L147-L180)). That semantics is wrong for a per-turn drain — both for repeated volatile drains and for re-injecting permanent notes only after compaction.

Replace those semantics with a single `delivered: Set<string>` set with the following lifecycle:

1. `pullDeliverables(): UserNote[]` — returns every disk note that is eligible for delivery and not yet in `delivered`, then adds the returned ids to `delivered`. Eligibility:
   - Volatile: `!acknowledged_at`.
   - Permanent: always eligible (acknowledged or not), because permanent notes must reappear after compaction.
   Notes are sorted oldest→newest, same ordering as today's `peekUnacknowledgedNotes`.
2. `acknowledgeNotes(): void` — iterates the `delivered` set, flips `acknowledged_at` for permanent notes, deletes volatile notes. **It removes ids that correspond to deleted volatile notes from the set, and leaves permanent ids in `delivered`** so the same permanent note is not re-injected on every subsequent `runLoop` iteration.
3. `resetDelivered(): void` — clears `delivered`. Called by `BaseAgent` after a successful `compactConversation` (via `InputChannel.onContextReset()` in Proposal B, or via the `onContextReset` config callback in Proposal A). Permanent notes therefore re-deliver on the very next `pullDeliverables` after compaction, which is exactly the existing semantics that `injectPendingNotes` provided at run-loop boundaries.
4. Renames: rename the existing `pendingAcknowledgment` field to `delivered`. Update `acknowledgeNote(noteId)` and `deleteNote(noteId)` to remove from the renamed set (those two methods today call `pendingAcknowledgment.delete(noteId)` at [src/runtime/notes.ts](src/runtime/notes.ts#L94-L116) and [src/runtime/notes.ts](src/runtime/notes.ts#L118-L131); the semantics is unchanged, only the field name).

`peekUnacknowledgedNotes()` is unchanged and remains the snapshot view for dashboard/tests (no lifecycle effect).

### Compaction-ordering invariant (key change from r1)

In `BaseAgent.runLoop`, the new channel hook **must run after** the compaction block at [src/agents/base.ts](src/agents/base.ts#L222-L240). The order per iteration becomes:

1. Abort check.
2. Compaction check; if it fires, replace history and call `onContextReset()` on every channel.
3. For every channel: `drain()`; if non-null, `pushMessage({role: "user", content: drained.message})`.
4. `callLLM()` and the rest of the loop unchanged.

This guarantees:
- A note that arrives just before compaction is not lost: after compaction the channel still has the same on-disk note (`delivered` was cleared by step 2) and re-injects it as a fresh post-compaction user message.
- A note that is marked delivered in step 3 is never silently discarded by a later same-iteration compaction (there isn't one — compaction only runs at the top of each iteration).
- Permanent notes re-appear after every compaction, matching today's behaviour from `injectPendingNotes`.

### Risk

- Medium. Touches `BaseAgent.runLoop` (hot path). The new hook is one method call per turn; if no channels are configured the loop is unchanged.
- Lifecycle change to `NoteManager` is the riskier part. Mitigated by replacing the only two callers in a single commit (`injectPendingNotes` is deleted, `attachPendingNotesNotice` is deleted) and by the test list below.

### What it enables

- `EventBus` + `NoteChannel` become symmetric: bus pushes events outward; channels push pending input messages inward. Future `SupervisorNudgeChannel`, `AbortPendingChannel`, etc. fit the same `InputChannel` shape.
- The dispatcher loses its role gate and stops importing `NoteManager`, making a future "dispatcher-without-agent-knowledge" refactor cheaper.
- F22 has exactly one chokepoint (`NoteChannel.drain()`) to migrate to `fs/promises`, not two.

### What it forbids

- Re-introducing agent-role checks in the dispatcher.
- Per-agent ad-hoc polling of `NoteManager`.
- Mutating `ToolCallResultEntry.content` for any purpose.
- Permanent notes being re-injected on every LLM turn (`delivered` filter prevents it between compactions).

### Test list (Proposal B specific; Proposal A maps 1:1 with the dispatcher-level equivalents)

`NoteChannel`:

- `drain` returns a formatted message containing every eligible note and marks them delivered.
- `drain` called twice in a row with no new notes returns `null` on the second call (verifies the `delivered` filter actually works on `pullDeliverables`).
- `drain` returns volatile notes that have not been acknowledged.
- `drain` returns permanent notes the first time, and `null` on the second call even though the permanent note is still on disk (verifies `delivered` prevents re-injection within a context).
- After `acknowledgeNotes` + `onContextReset`, `drain` returns the permanent note again (verifies compaction re-injection).
- After `acknowledgeNotes` *without* `onContextReset`, `drain` returns `null` for the permanent note (verifies no per-turn re-injection between compactions).

`BaseAgent` channel integration:

- A `BaseAgent` subclass with a stub `callLLM` and a stub `InputChannel` whose `drain()` returns a fixed message on first call and `null` afterwards: assert exactly one user-role message with that text is pushed before the first LLM call.
- Force compaction (low `thresholdPct`, large fake history). Assert `onContextReset()` is invoked exactly once per successful compaction, **before** the next `drain()` call.
- After compaction, the channel's `drain()` is allowed to re-inject (verified by the channel test above; here just assert the call order: compact → onContextReset → drain → callLLM).

`Dispatcher` (B):

- `processToolCalls` never mutates `ToolCallResultEntry.content`. The old `__saivage_pending_user_notes` test is replaced by an assertion that the returned content matches the raw tool output byte-for-byte.

### Recommendation note

Still B. It removes the second polling site, removes the dispatcher's role gate, and ties the lifecycle to a single set in a single place. The lifecycle revision and the compaction ordering invariant are now spelled out concretely enough to implement without ambiguity.

---

## Recommendation

**Proposal B.** Same justification as r1, strengthened: now the design specifies the lifecycle change explicitly (single `delivered` set on `NoteManager`, `pullDeliverables` + `resetDelivered`), and the compaction ordering (`drain` runs after compaction, channels get `onContextReset`). Proposal A is now also executable but still leaves two consumer sites of the same `NoteManager`, so the per-iteration code is duplicated and the compaction-reset callback ends up in `BaseAgentConfig` for one agent.

Cross-link with other findings:
- **F09** (worker-base helpers): independent files, no hard ordering constraint.
- **F22** (sync `fs`): land F06 first so F22 has one chokepoint (`NoteChannel.drain()`).
- **F08** (legacy runtime-state mirror): unrelated implementation-wise.
- **F03** (naive JSON-parsing): deleting `attachNoticeToContent`'s `try {JSON.parse} catch` removes one F03 target.
