# F06 — Implementation Plan (r4)

Plan for **Proposal B** (recommended in `02-design-r4.md`).

Repo: `/home/salva/g/ml/saivage`. Test runner: Vitest (`vitest.config.ts`). Build: `tsup`. Single commit, single revert.

## Changes from r3

- **Step 3 restructured** to extend the existing `BaseAgent.compactWithReinjection()` ([src/agents/base.ts](src/agents/base.ts#L823-L848)) instead of introducing a new `compactNow()` helper. The r3 plan would have bypassed two contracts the live helper already enforces: the FR-16 Planner pre-compaction memory-write hook ([src/agents/base.ts](src/agents/base.ts#L751-L811)) and the FR-15 §E.1 survivor-block reinjection ([src/agents/base.ts](src/agents/base.ts#L832-L847)). r4 adds one trailing `for` loop inside `compactWithReinjection()` to fire `onContextReset()` on every input channel after `replaceMessages`. Everything else inside the helper is preserved verbatim.
- **Step 3 keeps `drainChannels()` as a separate private helper** on `BaseAgent` because the drain step must run before every `router.chat` call regardless of whether compaction just happened. Both compaction sites' callers gain a `this.drainChannels()` call after the existing `await this.compactWithReinjection()` line. No new compaction helper is added.
- **Step 7 extended** with two new explicit retention assertions to prevent regressions while the channel plumbing is added:
  - Forced top-of-`runLoop` compaction tests that the survivor block is appended after `compactConversation` and before channel `onContextReset`.
  - Forced compaction with `role === "planner"` tests that `runPlannerCompactionHook` runs before `compactConversation`, that recursive `callLLM` calls inside the hook do not call `drainChannels()`, and that `onContextReset` still fires after `replaceMessages`.
- **Step 7 retains** the r3 repair-compaction test and extends it with an assertion that the survivor block is present in `this.messages` between the failing and retry `router.chat` calls when the knowledge loader is enabled.

## Ordered edit steps

### Step 1 — Introduce `InputChannel` interface

File: [src/agents/types.ts](src/agents/types.ts).

Add at the end of the existing exports:

```ts
export interface InputChannel {
  /** Return a single user-role message to inject before the next LLM turn, or null if nothing is pending. */
  drain(): { message: string } | null;
  /** Called by BaseAgent immediately after any successful compaction (after replaceMessages). */
  onContextReset(): void;
}
```

If `npm run typecheck` after Step 4 flags a circular import, move the interface to a new dedicated `src/agents/channels.ts` exporting only the interface.

### Step 2 — Change `NoteManager` lifecycle and add `NoteChannel`

File: [src/runtime/notes.ts](src/runtime/notes.ts).

1. Rename the private field `pendingAcknowledgment` → `delivered` ([src/runtime/notes.ts](src/runtime/notes.ts#L57)). Update internal mutations in `acknowledgeNote` ([src/runtime/notes.ts](src/runtime/notes.ts#L100)) and `deleteNote` ([src/runtime/notes.ts](src/runtime/notes.ts#L122)). The `Set<string>` type does not change.
2. **Delete** `getUnacknowledgedNotes()` ([src/runtime/notes.ts](src/runtime/notes.ts#L68-L76)) and `getPermanentNotes()` ([src/runtime/notes.ts](src/runtime/notes.ts#L91-L93)). The only caller is `PlannerAgent.injectPendingNotes` ([src/agents/planner.ts](src/agents/planner.ts#L253-L272)), which Step 4 deletes.
3. Add `pullDeliverables()`:
   ```ts
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
   resetDelivered(): void {
     this.delivered.clear();
   }
   ```
5. Update `acknowledgeNotes()` ([src/runtime/notes.ts](src/runtime/notes.ts#L147-L180)) so it iterates a snapshot (`const ids = [...this.delivered];`) and removes **only** the ids of deleted volatile notes from `this.delivered`. Permanent ids stay (they remain "already delivered in this context"). Replace the trailing `this.pendingAcknowledgment.clear()` with the per-id `this.delivered.delete(id)` inside the volatile branch.
6. `peekUnacknowledgedNotes()` is unchanged.

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

`formatNotesForInjection` already early-returns `""` for an empty list ([src/runtime/notes.ts](src/runtime/notes.ts#L185-L207)); the `drain` `notes.length === 0` short-circuit means we never push an empty message.

### Step 3 — Extend `compactWithReinjection` and add `drainChannels` in `BaseAgent`

File: [src/agents/base.ts](src/agents/base.ts).

1. Extend `BaseAgentConfig` with `inputChannels?: InputChannel[];` (import `InputChannel` from the location chosen in Step 1).
2. Add a private field `private readonly inputChannels: InputChannel[];` initialized from `config.inputChannels ?? []` in the constructor next to the existing `abortSignal` / `onActivity` / `onCompactionHookComplete` assignments at [src/agents/base.ts](src/agents/base.ts#L195-L197).
3. **Extend the existing `compactWithReinjection()` method** at [src/agents/base.ts](src/agents/base.ts#L823-L848). Do **not** remove or move the Planner pre-compaction hook call ([src/agents/base.ts](src/agents/base.ts#L824-L830)), the `compactConversation` call ([src/agents/base.ts](src/agents/base.ts#L831-L837)), the `buildSurvivorBlock` append ([src/agents/base.ts](src/agents/base.ts#L838-L846)), or the `replaceMessages(next)` call ([src/agents/base.ts](src/agents/base.ts#L847)). The only edit is adding a single trailing line after `this.replaceMessages(next);`:

   ```ts
   private async compactWithReinjection(): Promise<void> {
     if (this.role === "planner") {
       try {
         await this.runPlannerCompactionHook();
       } catch (err) {
         log.warn(/* unchanged */);
       }
     }
     const summarized = await compactConversation(/* unchanged */);
     let next: Message[] = summarized;
     try {
       const block = buildSurvivorBlock(/* unchanged */);
       if (block) next = [...summarized, { role: "user", content: block }];
     } catch (err) {
       log.warn(/* unchanged */);
     }
     this.replaceMessages(next);
     for (const ch of this.inputChannels) ch.onContextReset();   // NEW
   }
   ```

   Diff size in this method: +1 line. The channel-reset loop must come **after** `replaceMessages`, because the next outer-loop `drainChannels()` reads the post-compaction `delivered` state.

4. Add a new private helper `drainChannels()` immediately above `compactWithReinjection()` (or anywhere convenient between `replaceMessages` and `compactWithReinjection`):

   ```ts
   /** Push pending channel messages into this.messages. Call immediately before any router.chat. */
   private drainChannels(): void {
     for (const ch of this.inputChannels) {
       const drained = ch.drain();
       if (drained) this.pushMessage({ role: "user", content: drained.message });
     }
   }
   ```

5. **Top-of-`runLoop` site.** At [src/agents/base.ts](src/agents/base.ts#L218-L240), keep the existing `await this.compactWithReinjection();` call. Immediately after the surrounding `if (shouldCompact(...))` block closes — and before `let response: ChatResponse;` — insert `this.drainChannels();`:

   ```ts
   if (shouldCompact(this.messages, this.compactionConfig)) {
     if (isMaxCompactionsReached(this.compactionState, this.compactionConfig)) {
       log.warn(/* unchanged */);
       return { text: "Agent terminated: max compactions exceeded", finishReason: "max_compactions" };
     }
     await this.compactWithReinjection();
   }

   this.drainChannels();   // NEW

   // Make LLM call
   let response: ChatResponse;
   try { ... }
   ```

6. **`callLLM` repair-compaction site.** At [src/agents/base.ts](src/agents/base.ts#L518-L547), inside the `if (isContextOverflowError(msg) || isOrphanedToolResultError(msg))` branch, keep the existing `await this.compactWithReinjection();` call. Insert `this.drainChannels();` on the line immediately after it, before `this.pendingRoundId = myRoundId; continue;`:

   ```ts
   if (isContextOverflowError(msg) || isOrphanedToolResultError(msg)) {
     const reason = /* unchanged */;
     if (isMaxCompactionsReached(/* unchanged */)) { /* unchanged */ }
     this.addDiagnostic("model_repair", /* unchanged */);
     log.warn(/* unchanged */);
     await this.compactWithReinjection();
     this.drainChannels();   // NEW
     this.pendingRoundId = myRoundId;
     continue;
   }
   ```

   Net effect: any channel that was already drained earlier in this LLM turn (top-of-`runLoop` or a previous repair-compaction iteration) becomes eligible again after `onContextReset` (fired inside `compactWithReinjection`) and is re-injected as a fresh `{role: "user"}` message into `this.messages` before the retry `router.chat` (which reads `this.messages` directly in the `try { ... router.chat({ ..., messages: this.messages, ... }) }` block).

7. **Important: do not add `drainChannels()` inside `runPlannerCompactionHook`.** The hook's recursive `callLLM()` invocations at [src/agents/base.ts](src/agents/base.ts#L765) must remain unchanged so the pre-compaction memory-write conversation is not polluted with note injections. Channel reset still happens correctly: after the hook returns and `compactConversation` runs, the trailing `for ... onContextReset()` loop in `compactWithReinjection()` clears `delivered`, and the next outer `drainChannels()` re-injects pending notes against the fresh post-compaction history.

No other change to `base.ts`. The fallback path inside `compactConversation` also returns a replacement history; that path is covered because `compactWithReinjection()` runs `onContextReset` after `replaceMessages` regardless of whether the LLM summary succeeded or fell back to hard truncation ([src/runtime/compaction.ts](src/runtime/compaction.ts#L126-L143)).

### Step 4 — Switch `PlannerAgent` to the channel

File: [src/agents/planner.ts](src/agents/planner.ts).

1. In the constructor at [src/agents/planner.ts](src/agents/planner.ts#L186-L187), rebuild the order so the `NoteChannel` can be passed to `super`:
   - Construct `const noteManager = new NoteManager(ctx.project.paths.notes);` before the `super({...})` call.
   - Pass `inputChannels: [new NoteChannel(noteManager)]` into the `super` config object (next to the existing `childSpawner` / `initialMessage` fields).
   - After `super(...)` returns, assign `this.noteManager = noteManager`.
   - Import `NoteChannel` from `../runtime/notes.js`.
2. In `run()`, delete `await this.injectPendingNotes();` at [src/agents/planner.ts](src/agents/planner.ts#L191-L192).
3. Delete the entire `private async injectPendingNotes(): Promise<void>` method at [src/agents/planner.ts](src/agents/planner.ts#L253-L272).
4. Keep `this.noteManager.acknowledgeNotes();` at [src/agents/planner.ts](src/agents/planner.ts#L207) unchanged.

### Step 5 — Delete dispatcher side-channel

File: [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts).

1. Delete `this.attachPendingNotesNotice(results, ctx);` at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L144).
2. Delete the entire `private attachPendingNotesNotice(...)` method at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L302-L329).
3. Delete the two free functions `attachNoticeToContent` ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L331-L348)) and `truncateNoteContent` ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L349)).
4. Remove `import { NoteManager } from "./notes.js";` at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L12). Confirm no other reference to `NoteManager` remains in the file before deleting the import.

### Step 6 — Remove `planner_pointer_pending` from `create_note` return

File: [src/mcp/notes-server.ts](src/mcp/notes-server.ts).

Drop the `planner_pointer_pending: true` field from `handleToolCall`'s returned `content` object at [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L36-L42). Keep the existing `id`, `urgent`, `permanent`, and `path` fields exactly as they are today — F06 does not rename `id` to `note_id` and does not touch any other field.

After the edit the returned `content` should be:

```ts
return {
  content: {
    id: note.id,
    urgent: note.urgent,
    permanent: note.permanent,
    path: join(this.notesDir, `${note.id}.json`),
  },
  isError: false,
};
```

### Step 7 — Replace the runtime test (with FR-15/FR-16 retention assertions)

File: [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts).

1. Delete the `describe("Dispatcher pending note pointers", ...)` block at [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L853-L898). The dispatcher no longer mutates content.
2. Add a `describe("NoteChannel", ...)` block adjacent to existing `NoteManager` tests, covering:
   - `drain returns a formatted message containing every eligible note and marks them delivered`.
   - `drain called twice in a row with no new notes returns null on the second call` (volatile case — exercises the `delivered` filter on `pullDeliverables`).
   - `drain returns a permanent note the first time and null on the second call` (within the same context — no per-turn re-injection between compactions).
   - `after acknowledgeNotes without onContextReset, drain still returns null for the same permanent note`.
   - `after acknowledgeNotes and onContextReset, drain returns the permanent note again` (compaction re-injection).
   - `drain returns a volatile note that has been delivered but not yet acknowledged only once` (negative test for the r1 duplicate-injection bug).
3. Add a `describe("BaseAgent input channels", ...)` block:
   - Construct a minimal `BaseAgent` subclass with a stub `callLLM` (or stub `router.chat`) and a stub `InputChannel` whose `drain()` returns `{message: "hello"}` on first call and `null` thereafter, and whose `onContextReset()` is spy-able.
   - **Test 1 — basic drain.** One `runLoop` iteration pushes exactly one `{role: "user", content: "hello"}` message immediately before the LLM call.
   - **Test 2 — top-of-`runLoop` compaction (non-planner) preserves survivor reinjection.** Force compaction (low `thresholdPct`, prepopulated long history) on a non-planner role. Stub or wire `buildSurvivorBlock` so it returns a recognizable sentinel string (e.g. `"<<SURVIVOR>>"`). Assert call order on the same iteration: `compactConversation -> survivor-block append -> replaceMessages -> channel.onContextReset -> drainChannels -> callLLM`. Assert that the post-compaction `this.messages` contains the survivor sentinel **before** any channel-drained `{role: "user"}` message. This test fails if survivor reinjection is accidentally dropped.
   - **Test 3 — top-of-`runLoop` compaction with `role === "planner"` preserves the pre-compaction hook.** Same setup but Planner role. Stub `runPlannerCompactionHook` to flip a spy when invoked, OR stub `callLLM` so that the first invocation (inside the hook) returns a `create_memory` tool call, the second returns a final text response (terminating the hook), and the third (the post-compaction call) is the regular outer-loop LLM call. Assert:
     - `runPlannerCompactionHook` ran **before** `compactConversation`.
     - Inside the hook's recursive `callLLM`, `drainChannels()` was **not** called (the hook does not pollute the pre-compaction conversation with note injections).
     - After `compactConversation`, `channel.onContextReset` fired exactly once.
     - After the outer-loop `drainChannels()`, the post-compaction `this.messages` contains the channel-drained user message.
     - This test fails if the Planner pre-compaction memory-write hook is accidentally removed while extending `compactWithReinjection`.
   - **Test 4 — repair-compaction inside `callLLM` (kept from r3 + survivor-retention extension).** Stub `router.chat` so the first call throws an error matching `isContextOverflowError` and the second call resolves with `{toolCalls: [], finishReason: "stop", content: "ok"}`. Stub a channel with `drain()` returning `{message: "from-channel"}` only on its first call after each `onContextReset`, and a spy on `onContextReset`. With `buildSurvivorBlock` returning the sentinel string used in Test 2:
     - Assert `onContextReset` is invoked exactly once between the two `router.chat` calls (inside `compactWithReinjection`).
     - Assert the second `router.chat` call's `messages` argument contains a `{role: "user", content: "from-channel"}` message that was not present in the first call's `messages` argument.
     - Assert the survivor sentinel is present in `this.messages` between the failing and retry `router.chat` calls (pins survivor-reinjection retention on the repair path).
     - Repeat the assertions with an `isOrphanedToolResultError`-shaped error to cover the other branch of the catch.
   - **Test 5 — empty drain.** If the stub channel's `drain()` returns `null`, `runLoop` adds no `{role: "user"}` channel message that iteration.
4. Update any existing test that referenced `PlannerAgent.injectPendingNotes`, `NoteManager.getUnacknowledgedNotes`, or `NoteManager.getPermanentNotes`. Pre-edit grep to confirm:
   ```bash
   rg -n "injectPendingNotes|getUnacknowledgedNotes|getPermanentNotes|pendingAcknowledgment" src/ tests/ 2>/dev/null || true
   ```
   Replace each match with the channel-based equivalent (`pullDeliverables` / `NoteChannel.drain`) or delete the test if it pinned a behaviour that no longer exists.

If the existing test suite already has a forced-compaction test that exercises `runPlannerCompactionHook` or `buildSurvivorBlock`, keep it untouched and add the new channel-reset assertion onto it instead of duplicating it. Pre-edit grep:

```bash
rg -n "runPlannerCompactionHook|buildSurvivorBlock|compactWithReinjection" src/ tests/ 2>/dev/null || true
```

### Step 8 — Verify nothing else references the marker or removed APIs

Run from the repo root:

```bash
rg -n "__saivage_pending_user_notes|SAIVAGE_PENDING_USER_NOTES|planner_pointer_pending|attachPendingNotesNotice|attachNoticeToContent|injectPendingNotes|getUnacknowledgedNotes|getPermanentNotes|pendingAcknowledgment" src/ web/src/ tests/ 2>/dev/null
```

Expected hits after the edit: zero in `src/`, `web/src/`, `tests/`. Matches under `SPEC/v2/` outside this `F06/` directory are documentation references; leave them as historical context.

## Test strategy

Existing tests that already cover related behaviour:
- `src/runtime/runtime.test.ts` — `NoteManager` lifecycle (`acknowledgeNote`, `deleteNote`, `clearNotes`, `cleanupStaleNotes`, `formatNotesForInjection`). The public surface used by those tests is unchanged. The internal field rename `pendingAcknowledgment` → `delivered` is private; tests must not reference it.
- `peekUnacknowledgedNotes` tests are unchanged.
- If any existing forced-compaction test exercises `compactWithReinjection` (top-of-`runLoop` and/or the `callLLM` repair branch), keep its survivor-block and Planner pre-compaction hook assertions intact. New channel assertions are additive.

New tests written as part of Step 7:
- `NoteChannel.drain()` six cases listed above.
- `BaseAgent` input-channel integration five cases listed above, including the two new FR-15/FR-16 retention tests (Tests 2 and 3) and the survivor-retention extension on Test 4.

Validation commands (run in order, from `/home/salva/g/ml/saivage`):

```bash
npm run typecheck
npx vitest run src/runtime/runtime.test.ts
npx vitest run src/runtime
npx vitest run src/agents
npx vitest run
npm run build
```

`npx vitest run` (no path) is the project-wide gate. `npm run build` confirms `tsup` still emits a clean `dist/`.

## Rollback strategy

Single commit, single revert. Surface changes that the revert restores:

- `create_note` MCP tool response shape regains the `planner_pointer_pending: true` field on success. (The `id`/`urgent`/`permanent`/`path` fields are untouched in both directions.)
- `NoteManager` public API regains `getUnacknowledgedNotes()` and `getPermanentNotes()` and loses `pullDeliverables()` / `resetDelivered()`. The private field rename `delivered` → `pendingAcknowledgment` reverts too.
- `BaseAgentConfig` loses the `inputChannels` field; `BaseAgent` loses the `drainChannels()` helper and the trailing `onContextReset` loop inside `compactWithReinjection()`; the dispatcher regains the `attachPendingNotesNotice` path and `NoteManager` import. The Planner pre-compaction hook and survivor-block reinjection inside `compactWithReinjection()` were never touched, so the revert leaves them in their current state.

No on-disk `UserNote` schema changes. No project config additions. `git revert <sha>` is the only operation required.

## Cross-issue ordering

- **Must land before F22.** F22 migrates document I/O (including note reads) from sync to async `fs/promises`. After F06 there is one note-read hot path (`NoteChannel.drain` → `NoteManager.pullDeliverables` → `readAllNotes`); before F06 there are two.
- **Independent of F09.** F09 touches worker agent files, not `base.ts` or `planner.ts`.
- **Independent of F08.** No code overlap.
- **Independent of F03.** Landing F06 first removes one F03 target (`attachNoticeToContent`'s `try {JSON.parse} catch`).
