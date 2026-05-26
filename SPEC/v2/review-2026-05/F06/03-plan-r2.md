# F06 — Implementation Plan (r2)

Plan for **Proposal B** (recommended in `02-design-r2.md`).

Repo: `/home/salva/g/ml/saivage`. Test runner: Vitest (`vitest.config.ts`). Build: `tsup`. Single commit, single revert.

## Changes from r1

- **Step 2 rewritten.** The r1 claim that "calling `drain()` repeatedly returns `null` once all currently-pending notes are already in the set" was wrong: `getUnacknowledgedNotes()` adds to `pendingAcknowledgment` but never filters by it ([src/runtime/notes.ts](src/runtime/notes.ts#L69-L75)). r2 introduces a real lifecycle change in `NoteManager`: rename `pendingAcknowledgment` → `delivered`, add `pullDeliverables()` (filters by `delivered` then marks), `resetDelivered()`, and update `acknowledgeNotes()` to keep permanent ids in `delivered`. Deletes `getUnacknowledgedNotes()` and `getPermanentNotes()` (single callers go away with this commit).
- **Step 3 rewritten.** Channel drain now runs **after** the compaction block, not before. Compaction is required to call `onContextReset()` on every channel. This fixes the r1 hazard where draining + marking-pending before compaction lost the note when `compactConversation` replaced the entire history ([src/runtime/compaction.ts](src/runtime/compaction.ts#L113-L123)). New `InputChannel.onContextReset(): void` method added in Step 1.
- **Step 7 extended.** Test list now covers (a) repeated drains with volatile notes, (b) drain of unacknowledged permanent notes that does not re-fire next turn, (c) drain of already-acknowledged permanent notes that re-fires only after `onContextReset`, and (d) a `BaseAgent` test that asserts the post-compaction call order is compact → `onContextReset` → `drain` → `callLLM`.
- **Rollback section corrected.** Acknowledges the `create_note` MCP response shape change (loses `planner_pointer_pending`) and the `NoteManager` API change (`getUnacknowledgedNotes` / `getPermanentNotes` removed, `pullDeliverables` / `resetDelivered` added). Removes the r1 wording that claimed "no API surface changes".
- **Step 8 grep widened.** Adds `getUnacknowledgedNotes`, `getPermanentNotes`, and `pendingAcknowledgment` to the post-edit grep so the lifecycle rename is verified to leave no stragglers.

## Ordered edit steps

### Step 1 — Introduce `InputChannel` interface

File: [src/agents/types.ts](src/agents/types.ts).

Add at the end of the existing exports:

```ts
export interface InputChannel {
  /** Return a single user-role message to inject before the next LLM turn, or null if nothing is pending. */
  drain(): { message: string } | null;
  /** Called by BaseAgent right after a successful compactConversation. */
  onContextReset(): void;
}
```

If the typecheck flags a circular import (`agents/types.ts` is imported by `agents/base.ts` which already pulls from `runtime/`), move the interface to a new dedicated file `src/agents/channels.ts` exporting only the interface; decide based on `npm run typecheck` after Step 4. No other change to this file.

### Step 2 — Change `NoteManager` lifecycle and add `NoteChannel`

File: [src/runtime/notes.ts](src/runtime/notes.ts).

Lifecycle edits to `NoteManager`:

1. Rename the private field `pendingAcknowledgment` → `delivered` ([src/runtime/notes.ts](src/runtime/notes.ts#L57)). Update the three internal callers that mutate it: `acknowledgeNote` ([src/runtime/notes.ts](src/runtime/notes.ts#L100)), `deleteNote` ([src/runtime/notes.ts](src/runtime/notes.ts#L122)), and the comment on the field. The Set type does not change.
2. **Delete** `getUnacknowledgedNotes()` ([src/runtime/notes.ts](src/runtime/notes.ts#L68-L76)) and `getPermanentNotes()` ([src/runtime/notes.ts](src/runtime/notes.ts#L91-L93)). Both currently have exactly one caller, `PlannerAgent.injectPendingNotes` ([src/agents/planner.ts](src/agents/planner.ts#L253-L272)), which Step 4 deletes.
3. Add `pullDeliverables()`:
   ```ts
   /**
    * Return every note currently eligible for delivery and not yet delivered
    * in the current context; mark each returned id as delivered.
    *
    * Eligibility:
    *   - volatile note: !acknowledged_at
    *   - permanent note: always (so it can reappear after compaction)
    *
    * Permanent ids remain in `delivered` after acknowledgement so the same
    * permanent note is not re-injected on every LLM turn; they leave the
    * set only when `resetDelivered()` is called by compaction.
    */
   pullDeliverables(): UserNote[] {
     const candidates = this.readAllNotes()
       .filter((note) => !this.delivered.has(note.id))
       .filter((note) => note.permanent || !note.acknowledged_at)
       .sort((a, b) => a.created_at.localeCompare(b.created_at));
     for (const note of candidates) this.delivered.add(note.id);
     return candidates;
   }
   ```
4. Add `resetDelivered()`:
   ```ts
   /** Called by compaction so permanent notes re-deliver in the new context. */
   resetDelivered(): void {
     this.delivered.clear();
   }
   ```
5. Update `acknowledgeNotes()` ([src/runtime/notes.ts](src/runtime/notes.ts#L147-L180)) so that it iterates the current `delivered` set, but **only removes ids of deleted volatile notes** from the set. Permanent ids stay (they remain "already delivered in this context"). Concretely: replace the trailing `this.pendingAcknowledgment.clear();` with selective `this.delivered.delete(id)` calls in the volatile branch. The first guard (`if (this.delivered.size === 0) return;`) is preserved with the renamed field. Use a snapshot copy `const ids = [...this.delivered];` as today so removal during iteration is safe.
6. `peekUnacknowledgedNotes()` is unchanged. Dashboards/tests that snapshot still get the same data with no lifecycle effect ([src/runtime/notes.ts](src/runtime/notes.ts#L80-L84)).

Append the `NoteChannel` class at the end of the file:

```ts
import type { InputChannel } from "../agents/types.js"; // or "../agents/channels.js" if Step 1 split

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

`formatNotesForInjection` is already exported by being a method on `NoteManager` and already early-returns `""` for an empty list ([src/runtime/notes.ts](src/runtime/notes.ts#L185-L207)); the `drain` `notes.length === 0` short-circuit means we never push an empty message.

### Step 3 — Extend `BaseAgentConfig` and `runLoop` (drain after compaction)

File: [src/agents/base.ts](src/agents/base.ts).

1. Add to `BaseAgentConfig`:
   ```ts
   inputChannels?: InputChannel[];
   ```
   Import `InputChannel` from the location chosen in Step 1.
2. Store on `BaseAgent`: `private readonly inputChannels: InputChannel[];` initialised from `config.inputChannels ?? []` in the constructor (alongside the existing `abortSignal` / `onActivity` assignments at [src/agents/base.ts](src/agents/base.ts#L196-L197)).
3. Modify the compaction block at [src/agents/base.ts](src/agents/base.ts#L218-L240). After the successful `this.replaceMessages(await compactConversation(...))` call, invoke `onContextReset` on every channel:
   ```ts
   this.replaceMessages(await compactConversation(
     this.systemPrompt,
     this.messages,
     this.ctx.router,
     this.compactionConfig,
     this.compactionState,
   ));
   for (const ch of this.inputChannels) ch.onContextReset();
   ```
   The reset must run **only** when `compactConversation` resolves successfully. The fallback path inside `compactConversation` also returns a replacement history; that path counts as a context reset, so it is correctly covered by running `onContextReset` after the `replaceMessages` call regardless of whether the LLM summary succeeded or fell back to hard truncation ([src/runtime/compaction.ts](src/runtime/compaction.ts#L126-L143)).
4. Immediately after the compaction block and **before** the `// Make LLM call` comment at [src/agents/base.ts](src/agents/base.ts#L241-L247), add:
   ```ts
   for (const ch of this.inputChannels) {
     const drained = ch.drain();
     if (drained) this.pushMessage({ role: "user", content: drained.message });
   }
   ```
   This is the sole channel-drain site. It runs once per LLM turn, after any compaction this iteration, and before `callLLM`.

No other change to `base.ts`.

### Step 4 — Switch `PlannerAgent` to the channel

File: [src/agents/planner.ts](src/agents/planner.ts).

1. In the constructor at [src/agents/planner.ts](src/agents/planner.ts#L186-L187), rebuild the order so the `NoteChannel` can be passed to `super`:
   - Construct `const noteManager = new NoteManager(ctx.project.paths.notes);` before the `super({...})` call.
   - Pass `inputChannels: [new NoteChannel(noteManager)]` into the `super` config object (next to the existing `childSpawner` / `initialMessage` fields).
   - After `super(...)` returns, assign `this.noteManager = noteManager`.
   - Import `NoteChannel` from `../runtime/notes.js`.
2. In `run()`, delete `await this.injectPendingNotes();` at [src/agents/planner.ts](src/agents/planner.ts#L191-L192).
3. Delete the entire `private async injectPendingNotes(): Promise<void>` method at [src/agents/planner.ts](src/agents/planner.ts#L253-L272).
4. Keep `this.noteManager.acknowledgeNotes();` at [src/agents/planner.ts](src/agents/planner.ts#L207) unchanged. With the Step 2 lifecycle, that call still flushes per-cycle volatile acknowledgements; it now also leaves permanent ids in `delivered` so they don't re-fire on the next `runLoop` iteration.

### Step 5 — Delete dispatcher side-channel

File: [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts).

1. Delete `this.attachPendingNotesNotice(results, ctx);` at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L144).
2. Delete the entire `private attachPendingNotesNotice(...)` method at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L302-L329).
3. Delete the two free functions `attachNoticeToContent` ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L331-L348)) and `truncateNoteContent` ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L349)).
4. Remove the unused import `import { NoteManager } from "./notes.js";` at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L12). Confirm no other reference to `NoteManager` remains in the file before deleting the import.

### Step 6 — Remove `planner_pointer_pending` from `create_note` return

File: [src/mcp/notes-server.ts](src/mcp/notes-server.ts).

Drop the `planner_pointer_pending: true` field from `handleToolCall`'s returned `content` object at [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L37-L43). Keep `note_id` and `path` so chat surfaces can still confirm creation.

### Step 7 — Replace the runtime test

File: [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts).

1. Delete the `describe("Dispatcher pending note pointers", ...)` block at [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L853-L898). The dispatcher no longer mutates content.
2. Add a `describe("NoteChannel", ...)` block adjacent to existing `NoteManager` tests, covering:
   - `drain returns a formatted message containing every eligible note and marks them delivered`.
   - `drain called twice in a row with no new notes returns null on the second call` (volatile case — exercises the `delivered` filter on `pullDeliverables`).
   - `drain returns a permanent note the first time and null on the second call` (within the same context — verifies no per-turn re-injection between compactions).
   - `after acknowledgeNotes without onContextReset, drain still returns null for the same permanent note` (verifies acknowledged permanent ids remain in `delivered`).
   - `after acknowledgeNotes and onContextReset, drain returns the permanent note again` (verifies compaction re-injection).
   - `drain returns a volatile note that has been delivered but not yet acknowledged only once` (negative test for the r1 duplicate-injection bug).
3. Add a `describe("BaseAgent input channels", ...)` block:
   - Construct a minimal `BaseAgent` subclass with a stub `callLLM` returning `{toolCalls: [], finishReason: "stop", content: "ok", ...}`. Give it a stub `InputChannel` whose `drain()` returns `{message: "hello"}` on first call and `null` thereafter, and whose `onContextReset()` is spy-able.
   - Test 1: one `runLoop` iteration pushes exactly one `{role: "user", content: "hello"}` message immediately before the LLM call.
   - Test 2: force compaction (low `thresholdPct`, prepopulated long history) and assert call order: compact → channel `onContextReset` → channel `drain` → `callLLM`. Use a spy/mock for the stub channel's two methods.
   - Test 3: if the stub channel's `drain()` returns `null` and `onContextReset` is not triggered, no `{role: "user"}` channel message is added that iteration.
4. Update any existing test that referenced `PlannerAgent.injectPendingNotes`, `NoteManager.getUnacknowledgedNotes`, or `NoteManager.getPermanentNotes`. Pre-edit grep to confirm:
   ```bash
   rg -n "injectPendingNotes|getUnacknowledgedNotes|getPermanentNotes|pendingAcknowledgment" src/ tests/ 2>/dev/null || true
   ```
   Replace each match with the channel-based equivalent (`pullDeliverables` / `NoteChannel.drain`) or delete the test if it was pinning a behaviour that no longer exists.

### Step 8 — Verify nothing else references the marker or removed APIs

Run from the repo root:

```bash
rg -n "__saivage_pending_user_notes|SAIVAGE_PENDING_USER_NOTES|planner_pointer_pending|attachPendingNotesNotice|attachNoticeToContent|injectPendingNotes|getUnacknowledgedNotes|getPermanentNotes|pendingAcknowledgment" src/ web/src/ tests/ 2>/dev/null
```

Expected hits after the edit: zero in `src/`, `web/src/`, `tests/`. Any matches under `SPEC/v2/` outside this `F06/` directory are documentation references; leave them as historical context.

## Test strategy

Existing tests that already cover related behaviour:
- `src/runtime/runtime.test.ts` — `NoteManager` lifecycle for `acknowledgeNote`, `deleteNote`, `clearNotes`, `cleanupStaleNotes`, `formatNotesForInjection`. All continue to pass: the public surface used by those tests is unchanged. The internal field rename `pendingAcknowledgment` → `delivered` is private; tests should not be referencing it.
- `peekUnacknowledgedNotes` tests are unchanged.

New tests written as part of Step 7:
- `NoteChannel.drain()` six cases listed above.
- `BaseAgent` input-channel integration three cases listed above.

Validation commands (run in order, from `/home/salva/g/ml/saivage`):

```bash
npm run typecheck
npx vitest run src/runtime/notes.test.ts 2>/dev/null || true   # if a dedicated notes test file exists
npx vitest run src/runtime/runtime.test.ts
npx vitest run src/runtime
npx vitest run src/agents
npx vitest run
npm run build
```

`npx vitest run` (no path) is the project-wide gate. `npm run build` confirms `tsup` still emits a clean `dist/`.

## Rollback strategy

Single commit, single revert. Surface changes that the revert restores:

- `create_note` MCP tool response shape regains the `planner_pointer_pending: true` field on success.
- `NoteManager` public API regains `getUnacknowledgedNotes()` and `getPermanentNotes()` and loses `pullDeliverables()` / `resetDelivered()` (the private field rename `delivered` → `pendingAcknowledgment` reverts too).
- `BaseAgentConfig` loses the `inputChannels` field; the dispatcher regains the `attachPendingNotesNotice` path and `NoteManager` import.

No on-disk `UserNote` schema changes. No project config additions. `git revert <sha>` is the only operation required.

## Cross-issue ordering

- **Must land before F22.** F22 migrates document I/O (including note reads) from sync to async `fs/promises`. After F06 there is one note-read hot path (`NoteChannel.drain` → `NoteManager.pullDeliverables` → `readAllNotes`); before F06 there are two (`Dispatcher.attachPendingNotesNotice` per tool batch, `PlannerAgent.injectPendingNotes` per `runLoop` iteration). Doing F06 first gives F22 one chokepoint instead of two.
- **Independent of F09.** F09 touches worker agent files, not `base.ts` or `planner.ts`. Either order works.
- **Independent of F08.** No code overlap.
- **Independent of F03.** Landing F06 first removes one F03 target (`attachNoticeToContent`'s `try {JSON.parse} catch`).
