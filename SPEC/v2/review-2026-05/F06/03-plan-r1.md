# F06 — Implementation Plan (r1)

Plan for **Proposal B** (recommended in `02-design-r1.md`).

Repo: `/home/salva/g/ml/saivage`. Test runner: Vitest (`vitest.config.ts`). Build: `tsup`. Single commit, single revert.

## Ordered edit steps

### Step 1 — Introduce `InputChannel` interface

File: [src/agents/types.ts](src/agents/types.ts).

Add at the end of the existing exports:

```ts
export interface InputChannel {
  /** Return a single user-role message to inject before the next LLM turn, or null if nothing is pending. */
  drain(): { message: string } | null;
}
```

No other changes to this file.

### Step 2 — Implement `NoteChannel`

File: [src/runtime/notes.ts](src/runtime/notes.ts).

Add a new exported class at the end of the file (after `NoteManager`):

```ts
import type { InputChannel } from "../agents/types.js";

export class NoteChannel implements InputChannel {
  constructor(private readonly noteManager: NoteManager) {}

  drain(): { message: string } | null {
    const notes = this.noteManager.getUnacknowledgedNotes();
    const permanent = this.noteManager.getPermanentNotes();
    const all = [...notes, ...permanent.filter((p) => !notes.some((n) => n.id === p.id))];
    if (all.length === 0) return null;
    return { message: this.noteManager.formatNotesForInjection(all) };
  }
}
```

`getUnacknowledgedNotes` already adds drained ids to `pendingAcknowledgment`, so calling `drain()` repeatedly within a `runLoop` returns `null` once all currently-pending notes are already in the set and no new ones have arrived. No other change to `NoteManager`.

If TypeScript reports a circular-import warning (`agents/types.ts` is currently imported by `agents/base.ts` which imports from `runtime/`), move the new `InputChannel` interface to a new dedicated file `src/agents/channels.ts` exporting only the interface, and update `NoteChannel` plus `BaseAgent` to import from there. Decide based on `npm run typecheck` after Step 4.

### Step 3 — Extend `BaseAgentConfig` and `runLoop`

File: [src/agents/base.ts](src/agents/base.ts).

- Add to `BaseAgentConfig`:
  ```ts
  inputChannels?: InputChannel[];
  ```
- Store on `BaseAgent`: `protected readonly inputChannels: InputChannel[]` (default `[]`).
- In `runLoop`, immediately **before** the `if (shouldCompact(...))` block at [src/agents/base.ts](src/agents/base.ts#L222-L240), add:
  ```ts
  for (const ch of this.inputChannels) {
    const drained = ch.drain();
    if (drained) this.pushMessage({ role: "user", content: drained.message });
  }
  ```
  Placement before compaction is intentional: a note that arrives just before compaction should be visible in the post-compaction conversation, not discarded. Compaction already preserves the latest user messages by character budget.

No other change to `base.ts`.

### Step 4 — Switch `PlannerAgent` to the channel

File: [src/agents/planner.ts](src/agents/planner.ts).

- In the constructor, after building `this.noteManager`, build a `NoteChannel(this.noteManager)` and pass it via `inputChannels: [noteChannel]` to `super(...)`. Since `super` runs first, refactor to:
  - Create a local `const noteManager = new NoteManager(ctx.project.paths.notes);`
  - Pass `inputChannels: [new NoteChannel(noteManager)]` to `super`.
  - Then assign `this.noteManager = noteManager`.
- In `run()`, delete the call to `await this.injectPendingNotes();` at [src/agents/planner.ts](src/agents/planner.ts#L191-L192).
- Delete the `private async injectPendingNotes(): Promise<void>` method at [src/agents/planner.ts](src/agents/planner.ts#L253-L272).
- Keep `this.noteManager.acknowledgeNotes();` at [src/agents/planner.ts](src/agents/planner.ts#L207); it is now the single per-cycle flush for everything the channel drained.

### Step 5 — Delete dispatcher side-channel

File: [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts).

- Delete the `this.attachPendingNotesNotice(results, ctx);` call at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L144).
- Delete the entire `private attachPendingNotesNotice(...)` method at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L302-L329).
- Delete the two free functions at the bottom: `attachNoticeToContent` ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L331-L348)) and `truncateNoteContent` ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L349)). The latter has no other caller.
- Remove the now-unused import `import { NoteManager } from "./notes.js";` at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L12).

### Step 6 — Remove `planner_pointer_pending` from `create_note` return

File: [src/mcp/notes-server.ts](src/mcp/notes-server.ts).

In `handleToolCall`, drop the `planner_pointer_pending: true` field from the returned `content` object at [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L42). The note path and id remain so chat surfaces can still confirm creation.

### Step 7 — Replace the runtime test

File: [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts).

- Delete the entire `describe("Dispatcher pending note pointers", ...)` block at [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L853-L898). The dispatcher no longer mutates content.
- Add a new `describe("NoteChannel", ...)` block adjacent to the existing `NoteManager` tests:
  - `drain returns a formatted message that includes every unacknowledged note and marks them pending`.
  - `drain returns null after every note is already pending and no new note arrived`.
  - `drain merges permanent notes alongside unacknowledged notes without duplicates`.
- Add a focused `describe("BaseAgent input channels", ...)` block (or extend an existing base-agent test if one exists; otherwise add to this file since it already imports `NoteManager`):
  - Construct a minimal subclass of `BaseAgent` with a stub `callLLM` that returns a `{role: "user"}` echo, give it an `InputChannel` stub whose `drain()` returns a fixed message on the first call and `null` afterwards, run one loop iteration, and assert the messages array contains the channel's message immediately before the LLM round.
- Update any existing test that referenced `PlannerAgent.injectPendingNotes` (none expected from the grep — confirm before running). If found, replace assertions with channel-based equivalents.

### Step 8 — Verify nothing else references the marker

Run from the repo root:

```bash
rg -n "__saivage_pending_user_notes|SAIVAGE_PENDING_USER_NOTES|planner_pointer_pending|attachPendingNotesNotice|attachNoticeToContent" src/ web/src/ SPEC/v2/
```

Expected hits after the edit: zero in `src/` and `web/src/`. Any matches in `SPEC/v2/` outside this `F06/` directory are documentation references — leave them as historical context (the issue file is itself a `SPEC/v2/review-2026-05/F06-*.md` entry and references the symbol).

## Test strategy

Existing tests that already cover related behaviour:
- `src/runtime/runtime.test.ts` — `NoteManager` lifecycle (`getUnacknowledgedNotes`, `acknowledgeNotes`, `peekUnacknowledgedNotes`, `formatNotesForInjection`, `cleanupStaleNotes`). All continue to pass unchanged.
- `src/runtime/runtime.test.ts` — `Dispatcher pending note pointers`: replaced as described in Step 7.

New tests written as part of Step 7:
- `NoteChannel.drain()` happy/idempotent/empty/permanent-merge cases.
- `BaseAgent` invokes every configured `InputChannel.drain()` exactly once per `runLoop` iteration and pushes only non-null drains.

Validation commands (run in order):

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npx vitest run src/runtime/runtime.test.ts
npx vitest run src/runtime
npx vitest run
npm run build
```

`npx vitest run` (no path) is the project-wide gate. `npm run build` confirms `tsup` still emits a clean `dist/`.

## Rollback strategy

Single commit, single revert. The change is internal to the runtime + Planner construction; no on-disk format changes, no API surface changes, no config additions. `git revert <sha>` is sufficient. The on-disk `UserNote` schema is unchanged.

## Cross-issue ordering

- **Must land before F22.** F22 plans to migrate document I/O (including note reads) from sync to async `fs/promises`. After F06, the only note-read site in the hot path is `NoteChannel.drain()` (called once per LLM turn); before F06 there are two (`Dispatcher.attachPendingNotesNotice` per tool batch and `PlannerAgent.injectPendingNotes` per run-loop iteration). Doing F06 first gives F22 one chokepoint instead of two.
- **Independent of F09.** F09 extracts duplicated worker helpers (`normalizeTask`, `parseTaskReport`, `buildFailureReport`) into a shared module. It touches different files in `src/agents/` (the worker agent files, not `base.ts` or `planner.ts`). Either order works.
- **Independent of F08.** F08 removes the legacy `runtime-state.json` mirror in `src/runtime/recovery.ts`; no code overlap with this plan. Either order works.
- **Independent of F03.** F03 addresses naive JSON-parsing patterns; once `attachNoticeToContent`'s `try { JSON.parse(content) } catch { ... }` is deleted, F03 has one fewer site to fix. Either order works; landing F06 first removes one F03 target.
