# F06 — Design (r4)

## Changes from r3

- Resolves the r3 reviewer's blocker on the compaction abstraction. r3's centralized `compactNow()` helper called `compactConversation` directly ([SPEC/v2/review-2026-05/F06/02-design-r3.md](SPEC/v2/review-2026-05/F06/02-design-r3.md#L99-L108)) and would have bypassed two contracts that the live `BaseAgent.compactWithReinjection()` already enforces:
  1. **FR-16 Planner pre-compaction memory-write hook** — `runPlannerCompactionHook()` runs up to 5 turns of `create_memory` / `create_skill` calls before summarization when `this.role === "planner"` ([src/agents/base.ts](src/agents/base.ts#L751-L811), [src/agents/base.ts](src/agents/base.ts#L823-L830)).
  2. **FR-15 §E.1 survivor reinjection block** — after `compactConversation` returns, `buildSurvivorBlock(projectRoot, role, compactionCount)` is appended to the summarized history before `replaceMessages` ([src/agents/base.ts](src/agents/base.ts#L832-L847)).
- The r4 design **extends `compactWithReinjection()` in place** rather than introducing a new compaction helper. `compactWithReinjection()` is already the single chokepoint used by both compaction sites: top of `runLoop` ([src/agents/base.ts](src/agents/base.ts#L236)) and the `callLLM` repair branch ([src/agents/base.ts](src/agents/base.ts#L533)). The fix adds one final line: after `replaceMessages(next)`, fire `onContextReset()` on every input channel. No rename, no second compaction helper, no migration shim.
- `drainChannels()` is still a separate helper on `BaseAgent` because the drain step is independent of compaction (it must run before every `router.chat` call, whether or not compaction just happened). It is added at the same two sites where the r3 design placed it, but each site now follows the unchanged `compactWithReinjection()` call instead of a new `compactNow()`.
- The test plan is updated so the new channel-reset and drain coverage explicitly preserves the existing `compactWithReinjection()` behaviour. The forced-compaction tests must continue to exercise (a) the Planner pre-compaction hook firing when `role === "planner"`, and (b) the survivor-block reinjection appended after `compactConversation`. The new assertions about channel `onContextReset` and `drain` are added on top of, not in place of, those.

Two-proposal structure and the recommendation (B) are unchanged. The Proposal A scope text is updated for the same `compactWithReinjection()` integration.

---

## Proposal A — focused fix: emit a separate `user` message instead of mutating the tool result

### Scope (files touched)

- [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts) — replace `attachPendingNotesNotice` and `attachNoticeToContent`; widen `DispatchResult` with an optional `pendingNotesNotice` field populated from a new `NoteManager` method.
- [src/agents/base.ts](src/agents/base.ts) — extend `compactWithReinjection()` to fire `onContextReset` on all input channels after `replaceMessages` (see "Centralized compaction integration"). After pushing the `tool_result` user message at [src/agents/base.ts](src/agents/base.ts#L323-L335), if `dispatchResult.pendingNotesNotice` is non-null push a second `{role: "user", content: <formatted text>}` message.
- [src/runtime/notes.ts](src/runtime/notes.ts) — lifecycle change identical to Proposal B (see "Shared lifecycle change").
- [src/runtime/compaction.ts](src/runtime/compaction.ts) — no change. Channel reset is fired by `BaseAgent.compactWithReinjection()`, not by `compactConversation`.
- [src/mcp/notes-server.ts](src/mcp/notes-server.ts) — drop the `planner_pointer_pending` field from `create_note`'s return at [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L36-L42). Keep `id`, `urgent`, `permanent`, `path`.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts) — replace the `"Dispatcher pending note pointers"` describe block at [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L853-L898) with tests that assert (a) the dispatcher returns `pendingNotesNotice` on `DispatchResult` and does not mutate any `ToolCallResultEntry.content`, (b) the new lifecycle (see test list in the shared section).

### What gets added

- `DispatchResult.pendingNotesNotice?: { count: number; urgent_count: number; notes: PendingNoteRef[] }`.
- `formatPendingNotice(notes: UserNote[]): string` in `notes.ts`.
- `NoteManager.pullDeliverables(): UserNote[]` and `NoteManager.resetDelivered(): void` (shared lifecycle).
- `BaseAgentConfig.onContextReset?: () => void` callback, invoked from `compactWithReinjection()` after `replaceMessages`.

### What gets removed

- `Dispatcher.attachPendingNotesNotice` (entire method), `attachNoticeToContent`, `truncateNoteContent`.
- `__saivage_pending_user_notes` JSON key and `--- SAIVAGE_PENDING_USER_NOTES ---` text marker.
- `planner_pointer_pending: true` on `create_note`'s return shape.
- `NoteManager.getUnacknowledgedNotes()` and `NoteManager.getPermanentNotes()`.
- The r1 dispatcher-side-channel runtime test.

### Risk

Same as r3 — the `onContextReset` callback wires Planner-only behaviour into `BaseAgentConfig`. Proposal B avoids this.

### Recommendation note

A still leaves two consumer sites of `NoteManager` (the dispatcher's `pendingNotesNotice` and the new compaction-reset callback). Prefer B.

---

## Proposal B — level-up: notes are a first-class channel; one polling point in `BaseAgent`

### Scope (files touched)

- [src/agents/base.ts](src/agents/base.ts) — add `InputChannel` plumbing, extend the existing `compactWithReinjection()` with channel reset, add `drainChannels()` helper, wire both compaction sites' callers to drain channels after the existing helper returns.
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
  /** Called by BaseAgent immediately after any successful compaction (after replaceMessages). */
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

### Centralized compaction integration (key change from r3)

There is exactly one compaction helper in `BaseAgent`: the existing `compactWithReinjection()` at [src/agents/base.ts](src/agents/base.ts#L823-L848). F06 **extends** it; it does not replace it with a new helper.

Extension: at the very end of the method, after the existing `this.replaceMessages(next)` call, iterate `this.inputChannels` and invoke `onContextReset()` on each:

```ts
private async compactWithReinjection(): Promise<void> {
  if (this.role === "planner") {
    try {
      await this.runPlannerCompactionHook();
    } catch (err) {
      log.warn(/* unchanged */);
    }
  }
  const summarized = await compactConversation(
    this.systemPrompt,
    this.messages,
    this.ctx.router,
    this.compactionConfig,
    this.compactionState,
  );
  let next: Message[] = summarized;
  try {
    const block = buildSurvivorBlock(
      this.ctx.project.projectRoot,
      this.role as KnowledgeAgentRole,
      this.compactionState.compactionCount,
    );
    if (block) next = [...summarized, { role: "user", content: block }];
  } catch (err) {
    log.warn(/* unchanged */);
  }
  this.replaceMessages(next);
  for (const ch of this.inputChannels) ch.onContextReset();   // NEW
}
```

Everything that already lives inside `compactWithReinjection()` — the Planner pre-compaction memory-write hook, the call to `compactConversation`, the survivor-block append, the `replaceMessages` — is preserved verbatim. The only change is the trailing channel-reset loop.

A separate `drainChannels()` helper is added because the drain step is logically independent of compaction (it must run before every `router.chat` call, whether or not compaction just happened):

```ts
/** Push pending channel messages into this.messages. Call immediately before any router.chat. */
private drainChannels(): void {
  for (const ch of this.inputChannels) {
    const drained = ch.drain();
    if (drained) this.pushMessage({ role: "user", content: drained.message });
  }
}
```

Invariant: every place that constructs a `router.chat({ messages: this.messages, ... })` request is preceded, in execution order, by a `drainChannels()` call **after** the most recent `compactWithReinjection()` (if any) on the same iteration.

There are exactly two compaction sites; both already go through `compactWithReinjection()`, so the channel-reset semantics come for free at both. F06 only adds the matching `drainChannels()` call at each site:

1. **Top of `runLoop`** ([src/agents/base.ts](src/agents/base.ts#L222-L240)).
   ```ts
   if (shouldCompact(...) && !isMaxCompactionsReached(...)) {
     await this.compactWithReinjection();   // unchanged signature, channel-reset is inside
   }
   this.drainChannels();                    // NEW: pre-LLM drain
   response = await this.callLLM();
   ```
2. **Inside `callLLM`'s context-overflow / orphaned-tool-result catch branch** ([src/agents/base.ts](src/agents/base.ts#L518-L547)).
   ```ts
   } catch (err) {
     if (isContextOverflowError(msg) || isOrphanedToolResultError(msg)) {
       ...
       await this.compactWithReinjection();  // unchanged call; channel-reset is inside
       this.drainChannels();                 // NEW: re-inject pending notes before retry
       this.pendingRoundId = myRoundId;
       continue;                             // retry router.chat with this.messages
     }
     ...
   }
   ```

After `compactWithReinjection()`, `delivered` is empty on every channel (because `onContextReset()` ran inside the helper). The note that was previously delivered (and was just compacted away) becomes eligible again on the next `pullDeliverables()`, so `drainChannels()` pushes it as a fresh `{role: "user"}` message before the retry `router.chat` call (which reads `this.messages` directly inside the `try { router.chat({ ..., messages: this.messages, ... }) }` block).

Centralization (rather than copy-pasting `for (const ch of this.inputChannels) ch.onContextReset()` at each site) is the design choice: it keeps the invariant local to `compactWithReinjection()` and prevents a third future compaction site from silently re-introducing the same class of bug. A reader auditing the channel guarantee only has to inspect `compactWithReinjection()` and the two callers of `drainChannels()`.

The interaction with `runPlannerCompactionHook()` is benign: the hook runs before `compactConversation`, calling `this.callLLM()` recursively for up to 5 memory-write turns ([src/agents/base.ts](src/agents/base.ts#L751-L811)). Those recursive `callLLM` invocations do **not** run `drainChannels()` (only the outer `runLoop` iteration's caller does), so the pre-compaction hook conversation is not polluted with note injections, and after the hook's writes are persisted the eventual `compactConversation` summarizes them out together with the rest of the pre-compaction history. The `onContextReset` at the tail of `compactWithReinjection()` then clears `delivered` so the next outer-loop `drainChannels()` re-injects any volatile notes plus all permanent notes against the fresh post-compaction history.

### Shared lifecycle change (applies to A and B, defined here)

`NoteManager` today has one set, `pendingAcknowledgment`, which `getUnacknowledgedNotes()` only adds to (it never filters by it) and which `acknowledgeNotes()` fully clears ([src/runtime/notes.ts](src/runtime/notes.ts#L57-L75), [src/runtime/notes.ts](src/runtime/notes.ts#L147-L180)). Replace with:

1. Rename `pendingAcknowledgment` → `delivered`.
2. `pullDeliverables(): UserNote[]` — returns every disk note not in `delivered` whose eligibility holds, then adds the returned ids to `delivered`. Eligibility:
   - Volatile: `!acknowledged_at`.
   - Permanent: always eligible (must reappear after compaction).
   Notes are sorted oldest→newest.
3. `acknowledgeNotes(): void` — iterates `delivered`; flips `acknowledged_at` for permanent notes; deletes volatile notes and removes only their ids from `delivered`. Permanent ids stay in `delivered` so the same permanent note is not re-injected on every LLM turn between compactions.
4. `resetDelivered(): void` — clears `delivered`. Called by `BaseAgent.compactWithReinjection()` via `InputChannel.onContextReset()` (B), or via the `onContextReset` config callback (A).
5. `acknowledgeNote(noteId)` and `deleteNote(noteId)` continue to drop the id from the renamed set (current behaviour at [src/runtime/notes.ts](src/runtime/notes.ts#L94-L131)).

`peekUnacknowledgedNotes()` is unchanged.

### What gets removed

- `Dispatcher.attachPendingNotesNotice` and its helpers.
- `PlannerAgent.injectPendingNotes` and the call site.
- `NoteManager.getUnacknowledgedNotes()` and `NoteManager.getPermanentNotes()` (single callers disappear with `injectPendingNotes`).
- The `__saivage_pending_user_notes` JSON key, the text-marker fallback, `planner_pointer_pending`, and the dispatcher side-channel runtime test.
- The `NoteManager` import in `dispatcher.ts` and its role-gate.

### Risk

- Medium. Touches `BaseAgent.runLoop`, the `callLLM` retry path, and the tail of `compactWithReinjection()`. The compaction-helper change is a single appended `for` loop; the Planner pre-compaction hook and survivor-block append are not moved.
- Lifecycle change to `NoteManager` is the riskier part. Mitigated by deleting both callers (`injectPendingNotes`, `attachPendingNotesNotice`) in the same commit and by the test list below.

### What it enables

- `EventBus` + `NoteChannel` become symmetric: bus pushes events outward; channels push input inward. Future `SupervisorNudgeChannel`, `AbortPendingChannel`, etc. reuse `InputChannel`.
- The dispatcher loses its role gate and stops importing `NoteManager`.
- F22 has exactly one chokepoint (`NoteChannel.drain()`) to migrate to `fs/promises`.

### What it forbids

- Re-introducing agent-role checks in the dispatcher.
- Per-agent ad-hoc polling of `NoteManager`.
- Mutating `ToolCallResultEntry.content` for any purpose.
- A `router.chat()` call site that does not first run through `drainChannels()` after the most recent `compactWithReinjection()`.
- Introducing a second compaction helper that bypasses the Planner pre-compaction hook or the survivor-block reinjection.

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
- **Forced compaction at the top of `runLoop` (B + r4 retention assertions).** Low `thresholdPct`, prepopulated history, non-planner role to skip the pre-compaction hook. Assert call order: `compactConversation -> survivor-block append (if knowledge loader enabled) -> replaceMessages -> channel.onContextReset -> drainChannels -> callLLM`. The survivor-block assertion uses an injectable `buildSurvivorBlock` stub (or a fixture project with a knowledge file) so the test fails if the survivor reinjection is accidentally dropped while adding channel support.
- **Forced compaction with `role === "planner"` (r4 retention assertion).** Same setup but Planner role. Assert that `runPlannerCompactionHook` is invoked **before** `compactConversation`, that the hook's `callLLM` calls do **not** invoke `drainChannels()` (the recursive `callLLM` path is untouched), and that `channel.onContextReset` still fires after `replaceMessages`. The Planner hook is exercised via a stub `callLLM` returning a `create_memory` tool call once then a final text response, mirroring the existing `runPlannerCompactionHook` test pattern if one exists; otherwise this is the first one. This test must fail if the Planner pre-compaction hook is accidentally removed while extending `compactWithReinjection`.
- **Forced compaction inside `callLLM`'s repair branch (kept from r3).** Stub `router.chat` to throw a context-overflow error on the first attempt and resolve on the second. Stub a channel whose `drain()` returns `{message: "from-channel"}` and whose `onContextReset` is spy-able. Assert:
  - `onContextReset` is called exactly once between the two `router.chat` attempts (inside `compactWithReinjection`).
  - The second `router.chat` request payload contains a `{role: "user", content: "from-channel"}` message that is **not** present in the first attempt's payload.
  - The survivor block (when the knowledge loader is enabled) is present in `this.messages` between the two attempts. This pins survivor-reinjection retention for the repair path.
  - The same assertion with `isOrphanedToolResultError` instead of `isContextOverflowError`, to cover both branches of the catch.
- If the stub channel's `drain()` returns `null`, `runLoop` adds no `{role: "user"}` channel message that iteration.

`Dispatcher` (B):

- `processToolCalls` never mutates `ToolCallResultEntry.content`. The old `__saivage_pending_user_notes` test is replaced by an assertion that the returned content matches the raw tool output byte-for-byte.

### Recommendation note

Still B. It removes the second polling site, removes the dispatcher's role gate, and ties both compaction sites to one helper (`compactWithReinjection`) that is the sole source of the Planner pre-compaction hook, the survivor-block reinjection, and the channel-reset guarantee.

---

## Recommendation

**Proposal B.** Same justification as r1/r2/r3, with the r3 reviewer's blocker on the compaction abstraction closed: F06 extends `compactWithReinjection()` rather than replacing it, so the Planner pre-compaction memory-write hook (FR-16) and survivor-block reinjection (FR-15 §E.1) are preserved by construction. The channel-reset is one trailing `for` loop inside the existing helper; the drain is a separate `drainChannels()` helper used at the two call sites that already use `compactWithReinjection()`.

Cross-link with other findings:
- **F09** (worker-base helpers): independent files, no hard ordering constraint.
- **F22** (sync `fs`): land F06 first so F22 has one chokepoint (`NoteChannel.drain()`).
- **F08** (legacy runtime-state mirror): unrelated.
- **F03** (naive JSON-parsing): deleting `attachNoticeToContent`'s `try {JSON.parse} catch` removes one F03 target.
