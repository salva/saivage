# F06 — Implementation Plan (r3)

Plan for **Proposal B** (recommended in `02-design-r3.md`).

Repo: `/home/salva/g/ml/saivage`. Test runner: Vitest (`vitest.config.ts`). Build: `tsup`. Single commit, single revert.

## Changes from r2

- **Step 3 restructured** to introduce two private helpers on `BaseAgent` (`compactNow()` and `drainChannels()`) and to wire **both** compaction sites through them. The r2 plan only covered the top-of-`runLoop` compaction; r3 also covers the context-overflow / orphaned-tool-result repair compaction inside `callLLM()` at [src/agents/base.ts](src/agents/base.ts#L518-L547), so a freshly drained note is re-injected after that retry compaction instead of being lost.
- **Step 6 wording fixed.** The actual `create_note` MCP response field is `id`, not `note_id` ([src/mcp/notes-server.ts](src/mcp/notes-server.ts#L36-L42)). F06 deletes only `planner_pointer_pending`; it does **not** rename `id` to `note_id`. The other fields (`id`, `urgent`, `permanent`, `path`) are preserved unchanged.
- **Step 7 extended** with a focused test that exercises the `callLLM` repair compaction path: first `router.chat` throws context-overflow / orphaned-tool-result, channel `onContextReset` fires, channel `drain` runs, and the retry `router.chat` request contains the channel's message that the first attempt did not.
- **Step 8 grep widened** to include `getUnacknowledgedNotes`, `getPermanentNotes`, and `pendingAcknowledgment`.

## Ordered edit steps

### Step 1 — Introduce `InputChannel` interface

File: [src/agents/types.ts](src/agents/types.ts).

Add at the end of the existing exports:

```ts
export interface InputChannel {
  /** Return a single user-role message to inject before the next LLM turn, or null if nothing is pending. */
  drain(): { message: string } | null;
  /** Called by BaseAgent immediately after any successful compactConversation. */
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

### Step 3 — Centralize compaction/drain in `BaseAgent`

File: [src/agents/base.ts](src/agents/base.ts).

1. Extend `BaseAgentConfig` with `inputChannels?: InputChannel[];` (import `InputChannel` from the location chosen in Step 1).
2. Add a private field `private readonly inputChannels: InputChannel[];` initialized from `config.inputChannels ?? []` in the constructor next to the existing `abortSignal` / `onActivity` assignments at [src/agents/base.ts](src/agents/base.ts#L196-L197).
3. Add two private helpers on `BaseAgent` (place them right before `callLLM` at [src/agents/base.ts](src/agents/base.ts#L466)):
   ```ts
   /** Single source of truth for compaction: replaces messages and resets every channel. */
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

   /** Single source of truth for pushing channel messages into this.messages
    *  before any provider request. */
   private drainChannels(): void {
     for (const ch of this.inputChannels) {
       const drained = ch.drain();
       if (drained) this.pushMessage({ role: "user", content: drained.message });
     }
   }
   ```
4. Replace the top-of-`runLoop` compaction block at [src/agents/base.ts](src/agents/base.ts#L218-L240) so the `compactConversation` call goes through `compactNow()` and is immediately followed by a `drainChannels()` call before `callLLM`:
   ```ts
   if (shouldCompact(this.messages, this.compactionConfig)) {
     if (isMaxCompactionsReached(this.compactionState, this.compactionConfig)) {
       log.warn(`[agent:${this.role}:${this.id}] Max compactions reached — terminating`);
       return { text: "Agent terminated: max compactions exceeded", finishReason: "max_compactions" };
     }
     await this.compactNow();
   }

   this.drainChannels();

   // Make LLM call
   let response: ChatResponse;
   try { ... }
   ```
5. Replace the repair compaction inside `callLLM` at [src/agents/base.ts](src/agents/base.ts#L518-L547). Inside the `if (isContextOverflowError(msg) || isOrphanedToolResultError(msg))` branch, swap the inline `this.replaceMessages(await compactConversation(...))` for `await this.compactNow();` and add `this.drainChannels();` immediately after, before the existing `this.pendingRoundId = myRoundId; continue;`:
   ```ts
   if (isContextOverflowError(msg) || isOrphanedToolResultError(msg)) {
     const reason = isContextOverflowError(msg) ? "context window exceeded" : "orphaned tool_result";
     if (isMaxCompactionsReached(this.compactionState, this.compactionConfig)) {
       const failure = `Cannot repair malformed model request after ${this.compactionState.compactionCount} compactions (${reason}). Aborting this agent so the parent can handle the failure.`;
       this.addDiagnostic("model_issue", failure);
       this.pendingCall = null;
       this.pendingRoundId = null;
       throw new Error(failure);
     }
     this.addDiagnostic("model_repair", `Model request issue detected (${reason}). Compacting/regenerating conversation context and retrying without adding this diagnostic to the prompt.`);
     log.warn(`[agent:${this.role}:${this.id}] ${reason} — compacting and retrying`);
     await this.compactNow();
     this.drainChannels();
     this.pendingRoundId = myRoundId;
     continue;
   }
   ```
   Net effect: any channel that was already drained earlier in this LLM turn (top-of-`runLoop` or a previous repair-compaction iteration) becomes eligible again after `onContextReset` and is re-injected as a fresh `{role: "user"}` message into `this.messages` before the next `router.chat` retry. The retry uses `this.messages` directly inside the `try { const response = await this.ctx.router.chat({ ..., messages: this.messages, ... }) }` block.

No other change to `base.ts`. The fallback path inside `compactConversation` also returns a replacement history; that path is covered too because `compactNow()` runs `onContextReset` after `replaceMessages` regardless of whether the LLM summary succeeded or fell back to hard truncation ([src/runtime/compaction.ts](src/runtime/compaction.ts#L126-L143)).

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

### Step 7 — Replace the runtime test

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
   - **Test 2 — top-of-`runLoop` compaction.** Force compaction (low `thresholdPct`, prepopulated long history). Assert call order on the same iteration: `compactConversation -> channel.onContextReset -> channel.drain -> callLLM`.
   - **Test 3 — repair-compaction inside `callLLM` (new in r3).** Stub `router.chat` so the first call throws an error matching `isContextOverflowError` and the second call resolves with `{toolCalls: [], finishReason: "stop", content: "ok"}`. Stub a channel with `drain()` returning `{message: "from-channel"}` only on its first call after each `onContextReset`, and a spy on `onContextReset`. Assert:
     - `onContextReset` is invoked exactly once between the two `router.chat` calls.
     - The second `router.chat` call's `messages` argument contains a `{role: "user", content: "from-channel"}` message that was not present in the first call's `messages` argument.
     - The same assertions repeated with an `isOrphanedToolResultError`-shaped error to cover the other branch of the catch.
   - **Test 4 — empty drain.** If the stub channel's `drain()` returns `null`, `runLoop` adds no `{role: "user"}` channel message that iteration.
4. Update any existing test that referenced `PlannerAgent.injectPendingNotes`, `NoteManager.getUnacknowledgedNotes`, or `NoteManager.getPermanentNotes`. Pre-edit grep to confirm:
   ```bash
   rg -n "injectPendingNotes|getUnacknowledgedNotes|getPermanentNotes|pendingAcknowledgment" src/ tests/ 2>/dev/null || true
   ```
   Replace each match with the channel-based equivalent (`pullDeliverables` / `NoteChannel.drain`) or delete the test if it pinned a behaviour that no longer exists.

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

New tests written as part of Step 7:
- `NoteChannel.drain()` six cases listed above.
- `BaseAgent` input-channel integration four cases listed above (including the new repair-compaction case).

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
- `BaseAgentConfig` loses the `inputChannels` field; `BaseAgent` loses the `compactNow()` and `drainChannels()` helpers; the dispatcher regains the `attachPendingNotesNotice` path and `NoteManager` import.

No on-disk `UserNote` schema changes. No project config additions. `git revert <sha>` is the only operation required.

## Cross-issue ordering

- **Must land before F22.** F22 migrates document I/O (including note reads) from sync to async `fs/promises`. After F06 there is one note-read hot path (`NoteChannel.drain` → `NoteManager.pullDeliverables` → `readAllNotes`); before F06 there are two.
- **Independent of F09.** F09 touches worker agent files, not `base.ts` or `planner.ts`.
- **Independent of F08.** No code overlap.
- **Independent of F03.** Landing F06 first removes one F03 target (`attachNoticeToContent`'s `try {JSON.parse} catch`).
