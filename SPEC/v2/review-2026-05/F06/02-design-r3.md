# F06 — Design (r3)

## Changes from r2

- Closes the r2 reviewer's blocker on the second compaction path. The lifecycle invariant in r2 covered only the `shouldCompact` block at the top of `runLoop` ([src/agents/base.ts](src/agents/base.ts#L218-L240)). It did not cover the repair compaction inside `BaseAgent.callLLM()` that fires on context-overflow / orphaned-tool-result errors ([src/agents/base.ts](src/agents/base.ts#L518-L547)). That path replaces `this.messages` and immediately retries `router.chat({ messages: this.messages, ... })` without resetting channels or re-draining, so a freshly drained note that was just pushed by the pre-call drain would be lost.
- The fix is structural rather than a second sprinkle of the same two lines: Proposal B now centralizes the `compact + onContextReset + drain` sequence in two private helpers on `BaseAgent` (`compactNow()` and `drainChannels()`), and both compaction call sites use the same helper. The invariant becomes a single property of `compactNow()`: it always clears `delivered` on every channel, and the only mechanism that pushes the contents of channels into `this.messages` is `drainChannels()`, which is called immediately before any path that sends `this.messages` to the provider.
- Proposal A inherits the same helper structure (its `onContextReset` callback is fired by `compactNow()`, and the mid-loop `dispatchResult.pendingNotesNotice` consumer is supplemented with an explicit drain after the repair compaction).
- Wording fix: the Step 6 reference in r2's plan ("keep `note_id` and `path`") was wrong about the existing response field name. The `create_note` MCP tool returns `id`, not `note_id` ([src/mcp/notes-server.ts](src/mcp/notes-server.ts#L36-L42)). The F06 change deletes **only** `planner_pointer_pending` and leaves the existing `id`, `urgent`, `permanent`, and `path` fields untouched. No rename of `id` → `note_id` is intended.

Two-proposal structure and the recommendation (B) are unchanged.

---

## Proposal A — focused fix: emit a separate `user` message instead of mutating the tool result

### Scope (files touched)

- [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts) — replace `attachPendingNotesNotice` and `attachNoticeToContent`; widen `DispatchResult` with an optional `pendingNotesNotice` field populated from a new `NoteManager` method.
- [src/agents/base.ts](src/agents/base.ts) — see "Centralized compaction helper" below. After pushing the `tool_result` user message at [src/agents/base.ts](src/agents/base.ts#L323-L335), if `dispatchResult.pendingNotesNotice` is non-null push a second `{role: "user", content: <formatted text>}` message.
- [src/runtime/notes.ts](src/runtime/notes.ts) — lifecycle change identical to Proposal B (see "Shared lifecycle change").
- [src/runtime/compaction.ts](src/runtime/compaction.ts) — no change. Reset is fired by `BaseAgent.compactNow()`, not by `compactConversation`.
- [src/mcp/notes-server.ts](src/mcp/notes-server.ts) — drop the `planner_pointer_pending` field from `create_note`'s return at [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L36-L42). Keep `id`, `urgent`, `permanent`, `path`.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts) — replace the `"Dispatcher pending note pointers"` describe block at [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L853-L898) with tests that assert (a) the dispatcher returns `pendingNotesNotice` on `DispatchResult` and does not mutate any `ToolCallResultEntry.content`, (b) the new lifecycle (see test list in the shared section).

### What gets added

- `DispatchResult.pendingNotesNotice?: { count: number; urgent_count: number; notes: PendingNoteRef[] }`.
- `formatPendingNotice(notes: UserNote[]): string` in `notes.ts`.
- `NoteManager.pullDeliverables(): UserNote[]` and `NoteManager.resetDelivered(): void` (shared lifecycle).
- `BaseAgentConfig.onContextReset?: () => void` callback, invoked from `compactNow()` after a successful `compactConversation`.

### What gets removed

- `Dispatcher.attachPendingNotesNotice` (entire method), `attachNoticeToContent`, `truncateNoteContent`.
- `__saivage_pending_user_notes` JSON key and `--- SAIVAGE_PENDING_USER_NOTES ---` text marker.
- `planner_pointer_pending: true` on `create_note`'s return shape.
- `NoteManager.getUnacknowledgedNotes()` and `NoteManager.getPermanentNotes()`.
- The r1 dispatcher-side-channel runtime test.

### Risk

Same as r2 — the `onContextReset` callback wires Planner-only behaviour into `BaseAgentConfig`. Proposal B avoids this.

### Recommendation note

A still leaves two consumer sites of `NoteManager` (the dispatcher's `pendingNotesNotice` and `PlannerAgent.injectPendingNotes` deletion plus the new compaction-reset callback). Prefer B.

---

## Proposal B — level-up: notes are a first-class channel; one polling point in `BaseAgent`

### Scope (files touched)

- [src/agents/base.ts](src/agents/base.ts) — add `InputChannel` plumbing, the centralized `compactNow()` / `drainChannels()` helpers, and wire both compaction sites through them.
- [src/agents/planner.ts](src/agents/planner.ts) — delete `injectPendingNotes` ([src/agents/planner.ts](src/agents/planner.ts#L253-L272)) and its call at [src/agents/planner.ts](src/agents/planner.ts#L191-L192). Configure the Planner with `inputChannels: [new NoteChannel(noteManager)]`. Keep `this.noteManager.acknowledgeNotes()` at [src/agents/planner.ts](src/agents/planner.ts#L207).
- [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts) — delete `attachPendingNotesNotice` ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L302-L329)), `attachNoticeToContent` ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L331-L348)), `truncateNoteContent`, the post-dispatch call at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L144), and the `NoteManager` import at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L12).
- [src/runtime/notes.ts](src/runtime/notes.ts) — shared lifecycle change plus a new exported `NoteChannel` class.
- [src/agents/types.ts](src/agents/types.ts) — narrow `InputChannel` interface.
- [src/mcp/notes-server.ts](src/mcp/notes-server.ts) — drop `planner_pointer_pending` from `create_note`'s return. Keep `id`, `urgent`, `permanent`, `path`.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts) — replace the dispatcher side-channel test with channel-level tests (see Test list).

### What gets added

```ts
// src/agents/types.ts
export interface InputChannel {
  /** Return a single user-role message to inject before the next LLM turn, or null if nothing is pending. */
  drain(): { message: string } | null;
  /** Called by BaseAgent immediately after any successful compactConversation. */
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

`BaseAgentConfig.inputChannels?: InputChannel[]` (default `[]`).

### Centralized compaction helper (key change from r2)

`BaseAgent` gains two private helpers and uses them at every compaction or pre-`chat` site:

```ts
// Single mechanism for replacing this.messages via compaction. Always fires onContextReset.
private async compactNow(): Promise<void> {
  this.replaceMessages(await compactConversation(
    this.systemPrompt,
    this.messages,
    this.ctx.router,
    this.compactionConfig,
    this.compactionState,
  ));
  for (const ch of this.inputChannels) ch.onContextReset();
}

// Single mechanism for pushing channel messages into this.messages.
// Always called immediately before any path that sends this.messages to the provider.
private drainChannels(): void {
  for (const ch of this.inputChannels) {
    const drained = ch.drain();
    if (drained) this.pushMessage({ role: "user", content: drained.message });
  }
}
```

Invariant: every place that constructs a `router.chat({ messages: this.messages, ... })` request is preceded, in execution order, by a `drainChannels()` call **after** the most recent `compactNow()` (if any) on the same iteration.

There are exactly two compaction sites; both go through `compactNow()`:

1. **Top of `runLoop`** ([src/agents/base.ts](src/agents/base.ts#L222-L240)).
   ```
   if (shouldCompact(...) && !isMaxCompactionsReached(...)) await this.compactNow();
   this.drainChannels();
   response = await this.callLLM();
   ```
2. **Inside `callLLM`'s context-overflow / orphaned-tool-result catch branch** ([src/agents/base.ts](src/agents/base.ts#L518-L547)).
   ```
   } catch (err) {
     if (isContextOverflowError(msg) || isOrphanedToolResultError(msg)) {
       ...
       await this.compactNow();      // replaces messages + resets all channels
       this.drainChannels();         // re-injects pending notes as a fresh user message
       continue;                     // retry router.chat with this.messages
     }
     ...
   }
   ```

After `compactNow()`, `delivered` is empty on every channel. The note that was previously delivered (and was just compacted away) becomes eligible again on the next `pullDeliverables()`, so `drainChannels()` pushes it as a fresh `{role: "user"}` message before the retry `router.chat`. This is the same recovery that the top-of-loop sequence provides, applied to the retry site.

Centralization (rather than copy-pasting the two-line sequence) is the design choice: it keeps the invariant local to `BaseAgent` and prevents a third future compaction site from silently re-introducing the same class of bug. A reader auditing the channel guarantee only has to inspect `compactNow()` and the two callers of `drainChannels()`.

### Shared lifecycle change (applies to A and B, defined here)

`NoteManager` today has one set, `pendingAcknowledgment`, which `getUnacknowledgedNotes()` only adds to (it never filters by it) and which `acknowledgeNotes()` fully clears ([src/runtime/notes.ts](src/runtime/notes.ts#L57-L75), [src/runtime/notes.ts](src/runtime/notes.ts#L147-L180)). Replace with:

1. Rename `pendingAcknowledgment` → `delivered`.
2. `pullDeliverables(): UserNote[]` — returns every disk note not in `delivered` whose eligibility holds, then adds the returned ids to `delivered`. Eligibility:
   - Volatile: `!acknowledged_at`.
   - Permanent: always eligible (must reappear after compaction).
   Notes are sorted oldest→newest.
3. `acknowledgeNotes(): void` — iterates `delivered`; flips `acknowledged_at` for permanent notes; deletes volatile notes and removes only their ids from `delivered`. Permanent ids stay in `delivered` so the same permanent note is not re-injected on every LLM turn between compactions.
4. `resetDelivered(): void` — clears `delivered`. Called by `BaseAgent.compactNow()` (via `InputChannel.onContextReset()` in Proposal B, or via the `onContextReset` config callback in Proposal A).
5. `acknowledgeNote(noteId)` and `deleteNote(noteId)` continue to drop the id from the renamed set (current behaviour at [src/runtime/notes.ts](src/runtime/notes.ts#L94-L131)).

`peekUnacknowledgedNotes()` is unchanged.

### What gets removed

- `Dispatcher.attachPendingNotesNotice` and its helpers.
- `PlannerAgent.injectPendingNotes` and the call site.
- `NoteManager.getUnacknowledgedNotes()` and `NoteManager.getPermanentNotes()` (single callers disappear with `injectPendingNotes`).
- The `__saivage_pending_user_notes` JSON key, the text-marker fallback, `planner_pointer_pending`, and the dispatcher side-channel runtime test.
- The `NoteManager` import in `dispatcher.ts` and its role-gate.

### Risk

- Medium. Touches `BaseAgent.runLoop` and the `callLLM` retry path. Both changes are mechanical relocations through the new helpers; no new state is introduced beyond the `inputChannels` array.
- Lifecycle change to `NoteManager` is the riskier part. Mitigated by deleting both callers (`injectPendingNotes`, `attachPendingNotesNotice`) in the same commit and by the test list below.

### What it enables

- `EventBus` + `NoteChannel` become symmetric: bus pushes events outward; channels push input inward. Future `SupervisorNudgeChannel`, `AbortPendingChannel`, etc. reuse `InputChannel`.
- The dispatcher loses its role gate and stops importing `NoteManager`.
- F22 has exactly one chokepoint (`NoteChannel.drain()`) to migrate to `fs/promises`.

### What it forbids

- Re-introducing agent-role checks in the dispatcher.
- Per-agent ad-hoc polling of `NoteManager`.
- Mutating `ToolCallResultEntry.content` for any purpose.
- A `router.chat()` call site that does not first run through `drainChannels()` after the most recent `compactNow()`.

### Test list (Proposal B specific; Proposal A maps 1:1 with the dispatcher-level equivalents)

`NoteChannel`:

- `drain` returns a formatted message containing every eligible note and marks them delivered.
- `drain` called twice with no new notes returns `null` on the second call.
- `drain` returns volatile notes that have not been acknowledged.
- `drain` returns permanent notes the first time and `null` on the second within the same context.
- After `acknowledgeNotes` + `onContextReset`, `drain` returns the permanent note again.
- After `acknowledgeNotes` without `onContextReset`, `drain` returns `null` for the permanent note.

`BaseAgent` channel integration:

- One `runLoop` iteration with a stub channel and stub `callLLM` pushes exactly one user-role channel message immediately before the LLM call.
- Force compaction at the top of `runLoop` (low `thresholdPct`, prepopulated history): assert call order `compactConversation -> channel.onContextReset -> channel.drain -> callLLM`.
- **Force compaction inside `callLLM`'s repair branch (new in r3).** Stub `router.chat` to throw a context-overflow error on the first attempt and resolve on the second. Stub a channel whose `drain()` returns `{message: "from-channel"}` and whose `onContextReset` is spy-able. Assert:
  - `onContextReset` is called exactly once between the two `router.chat` attempts.
  - The second `router.chat` request payload contains a `{role: "user", content: "from-channel"}` message that is **not** present in the first attempt's payload.
  - The same assertion with `isOrphanedToolResultError` instead of `isContextOverflowError`, to cover both branches of the catch.
- If the stub channel's `drain()` returns `null`, `runLoop` adds no `{role: "user"}` channel message that iteration.

`Dispatcher` (B):

- `processToolCalls` never mutates `ToolCallResultEntry.content`. The old `__saivage_pending_user_notes` test is replaced by an assertion that the returned content matches the raw tool output byte-for-byte.

### Recommendation note

Still B. It removes the second polling site, removes the dispatcher's role gate, and ties both compaction sites to one helper that is the sole source of the channel-reset guarantee.

---

## Recommendation

**Proposal B.** Same justification as r1/r2, strengthened in r3: the lifecycle is owned by a single helper (`compactNow`) and the drain is owned by a single helper (`drainChannels`), so the invariant "no `router.chat` call uses stale post-compaction state" is local and auditable. The r2 reviewer's blocker on the second compaction path is closed by the same mechanism that covers the first.

Cross-link with other findings:
- **F09** (worker-base helpers): independent files, no hard ordering constraint.
- **F22** (sync `fs`): land F06 first so F22 has one chokepoint (`NoteChannel.drain()`).
- **F08** (legacy runtime-state mirror): unrelated.
- **F03** (naive JSON-parsing): deleting `attachNoticeToContent`'s `try {JSON.parse} catch` removes one F03 target.
