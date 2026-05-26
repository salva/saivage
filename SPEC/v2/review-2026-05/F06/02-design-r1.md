# F06 — Design (r1)

Two proposals. Both delete `attachPendingNotesNotice`, the `__saivage_pending_user_notes` JSON key, the text-marker fallback, and the test that pins the side-channel shape ([src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L853-L898)).

---

## Proposal A — focused fix: emit a separate `user` message instead of mutating the tool result

### Scope (files touched)

- [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts) — replace `attachPendingNotesNotice` and `attachNoticeToContent`; widen `DispatchResult` with an optional `pendingNotesNotice` field.
- [src/agents/base.ts](src/agents/base.ts) — after pushing the `tool_result` user message at [src/agents/base.ts](src/agents/base.ts#L323-L336), if `dispatchResult.pendingNotesNotice` is non-null push a second `{role: "user", content: <formatted text>}` message.
- [src/runtime/notes.ts](src/runtime/notes.ts) — add a small `formatPendingNotice(notes)` helper next to `formatNotesForInjection` that returns a short text alert plus the same pointer list the side-channel exposed (id, urgent, channel, preview). Pure function, no I/O.
- [src/mcp/notes-server.ts](src/mcp/notes-server.ts) — drop the `planner_pointer_pending` field from `create_note`'s return (now meaningless; only the dispatcher mid-loop hook ever populated the corresponding signal).
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts) — delete the `"Dispatcher pending note pointers"` describe block and replace with one that asserts the dispatcher returns a `pendingNotesNotice` on `DispatchResult` and that no tool-result content is mutated.

### What gets added

- `DispatchResult.pendingNotesNotice?: { count: number; urgent_count: number; notes: PendingNoteRef[] }`.
- `formatPendingNotice(notes: UserNote[]): string` in `notes.ts`, used by `BaseAgent` to render the second user message.
- A single private `BaseAgent.maybeInjectPendingNotesNotice(notice)` helper invoked exactly once per tool-result batch.

### What gets removed

- `Dispatcher.attachPendingNotesNotice` (entire method).
- `attachNoticeToContent` and `truncateNoteContent` free functions in `dispatcher.ts` (the latter moves into `notes.ts` as part of the new formatter).
- The `__saivage_pending_user_notes` JSON key — every grep hit deleted.
- The `--- SAIVAGE_PENDING_USER_NOTES ---` text marker — every grep hit deleted.
- `planner_pointer_pending: true` field on `create_note`'s return shape.
- The old runtime test that locks in the side-channel JSON.

### Risk

- Low. The new user message is just another conversation entry; the Planner's system prompt already documents pending-note handling at [src/agents/planner.ts](src/agents/planner.ts#L84-L88). One-line prompt amendment ("notes also surface mid-loop as a `[NOTES PENDING]` user message after tool results") may be desirable but is not strictly required since the message is human-readable.
- The Planner's run-loop boundary injection (`injectPendingNotes`) still fires on the next iteration, so the two channels now both push `{role: "user"}` text and the boundary one may re-introduce the same content. This is benign (same notes, mark-pending happens in the boundary path) but is wasted tokens. Mitigation: have `BaseAgent.maybeInjectPendingNotesNotice` flag the notes as already-seen by reusing the `NoteManager.pendingAcknowledgment` set — same `getUnacknowledgedNotes` semantics — so the boundary `injectPendingNotes` filters them out. This means the focused fix already changes the dispatcher from a peek (no lifecycle) to a real injection (with lifecycle); the duplicated `injectPendingNotes` path then becomes a no-op when the mid-loop path already fired.

### What it enables

- Future schema enforcement of `ToolCallResultEntry.content` (would let F03's JSON-handling cleanup actually constrain the type).
- Reuse of the same notice mechanism for non-Planner agents (Chat, future supervisor agents) by lifting the role gate — currently impossible because the JSON-splice would corrupt their tool results too.

### What it forbids

- Re-introducing any tool-result mutation by the dispatcher.
- Carrying the JSON marker through to the UI (the marker shape is removed in the same commit).

### Recommendation note

A is the smallest viable fix and is enough to satisfy the issue as stated. It still leaves *two* code paths (`PlannerAgent.injectPendingNotes` and the new `BaseAgent` mid-loop hook) doing essentially the same thing — only at different sync points.

---

## Proposal B — level-up: notes are a first-class channel; one polling point in `BaseAgent`

### Scope (files touched)

- [src/agents/base.ts](src/agents/base.ts) — add a `NoteChannel` (or generic `InputChannel`) injection point that is consulted **once per LLM turn**, before the LLM call at [src/agents/base.ts](src/agents/base.ts#L245-L248). Push pending notes as a real `{role: "user"}` message if any are present.
- [src/agents/planner.ts](src/agents/planner.ts) — delete `injectPendingNotes` and its call site at [src/agents/planner.ts](src/agents/planner.ts#L191-L192) and [src/agents/planner.ts](src/agents/planner.ts#L253-L272). Configure the Planner with a `NoteChannel(noteManager)` instance via `BaseAgentConfig`. Keep the `acknowledgeNotes()` call after every `runLoop()` exit ([src/agents/planner.ts](src/agents/planner.ts#L207)), because that flushes the per-cycle set that the channel populates.
- [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts) — delete `attachPendingNotesNotice`, `attachNoticeToContent`, `truncateNoteContent`, the `NoteManager` import, and the post-dispatch call at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L144).
- [src/runtime/notes.ts](src/runtime/notes.ts) — `NoteChannel` lives here; it wraps `NoteManager` and exposes a single `drainUnacknowledged(): {message: string} | null` that internally calls `getUnacknowledgedNotes()` + `formatNotesForInjection()`.
- [src/agents/types.ts](src/agents/types.ts) and [src/agents/base.ts](src/agents/base.ts) — add a narrow `InputChannel` interface (`{ drain(): {message: string} | null }`) so the same hook can later host other producers (event-bus subscriptions, supervisor nudges).
- [src/mcp/notes-server.ts](src/mcp/notes-server.ts) — drop `planner_pointer_pending` from `create_note`'s return.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts) — replace the dispatcher side-channel test with channel-level tests:
  - `NoteChannel.drain()` returns a formatted message with permanent notes merged and marks them pending.
  - `BaseAgent` with a `NoteChannel` configured pushes exactly one `user` message per LLM turn when notes are pending and zero when none are pending.
  - `PlannerAgent` flushes pending acknowledgements on every `runLoop()` exit.
  - Existing planner-injection tests that referenced `injectPendingNotes` need their assertion targets updated.

### What gets added

- `interface InputChannel { drain(): { message: string } | null; }` (single-method).
- `class NoteChannel implements InputChannel` in `notes.ts`. Replaces ad-hoc note polling in two files with one.
- A `BaseAgentConfig.inputChannels?: InputChannel[]` field. `BaseAgent.runLoop` consults each channel once per iteration before `callLLM` and pushes the returned message (if any) as a real user message.

### What gets removed

- `Dispatcher.attachPendingNotesNotice` and all helpers.
- `PlannerAgent.injectPendingNotes` and its call site.
- The role-gated polling logic in `dispatcher.ts` (no more `ctx.role === "planner"` branch there).
- The `__saivage_pending_user_notes` marker, the text-marker fallback, and `planner_pointer_pending`.
- The `NoteManager` import inside `dispatcher.ts`.

### Risk

- Medium. Touches `BaseAgent.runLoop`, which is the hot path for every agent. The new hook is one early-return-shaped call per turn; provided `NoteChannel.drain()` returns `null` cheaply when no notes exist (no `readdirSync` if the directory is empty — already true via the `existsSync` guard in `readAllNotes` at [src/runtime/notes.ts](src/runtime/notes.ts#L259-L262)) the overhead is negligible.
- Slight ordering change: today the Planner sees notes at the **start of each `run()` iteration**; with B it sees them at the **start of each LLM turn**, which is strictly more frequent. The Planner's prompt already says "the runtime injects pending notes into your context before each turn" ([src/agents/planner.ts](src/agents/planner.ts#L84-L86)) — the new behaviour finally matches the prompt.
- `acknowledgeNotes()` still runs only on `runLoop` exit. Inside a long `runLoop`, the same notes may be drained → pushed → the Planner acts on them in turn 1 → on turn 2 they would be drained again because acknowledgement hasn't run yet. Fix: `NoteChannel.drain()` consults `pendingAcknowledgment` and returns `null` if every unacknowledged note is already in that set. The set is per-`NoteManager` instance, which is exactly what we want (one Planner ↔ one NoteManager ↔ one NoteChannel).

### What it enables

- The `EventBus` and `NoteChannel` become symmetric: the bus pushes events to external subscribers (Chat, Telegram), the channel pushes pending-input messages to agents. Future "supervisor nudge", "compaction-just-happened banner", and "abort signal pending" inputs all fit the same `InputChannel` shape without growing dispatcher responsibilities or planner-specific logic.
- Removes the role-gating in the dispatcher, so the dispatcher itself becomes role-agnostic (one less thing it has to know about the agent hierarchy). This is a precondition for any future refactor that wants to move dispatcher into a non-agent-aware module.
- Pairs naturally with F09's task-report helper extraction: both pull responsibilities out of agent-specific modules and into shared infrastructure.

### What it forbids

- Any reintroduction of agent-role checks in the dispatcher.
- Per-agent ad-hoc polling of `NoteManager`. The only consumers are `NoteChannel` (read) and the Planner's post-`runLoop` `acknowledgeNotes()` (write).
- Mutating `ToolCallResultEntry.content` for any purpose.

---

## Recommendation

**Proposal B.** A would fix the literal complaint in F06 but leave the deeper duplication (Planner-level boundary polling and dispatcher mid-loop polling) intact. The system already has *two* polling sites for the same data with different lifecycle semantics — that is exactly the leaky-abstraction smell that produced the side-channel in the first place. Per project guideline 1 (no transitional shims, refactor broadly when it improves the design), the level-up consolidates both into one `InputChannel` hook in `BaseAgent`, deletes the dispatcher's role gate, and lets the existing `EventBus` and the new `NoteChannel` carry the orthogonal responsibilities they actually represent. The added abstraction (`InputChannel` interface) has one production implementation today but is genuinely shaped by a single method; it is not premature configurability, it is the minimal shape needed to remove the duplication.

Cross-link with other findings:
- **F09** (worker-base helpers): both proposals B for F06 and F09 push code out of agent-role modules into shared infrastructure under `src/agents/` and `src/runtime/`. They touch disjoint regions of `base.ts` and `agents/*.ts` and can be ordered either way; if F09 lands first, F06's `BaseAgentConfig` extension goes onto a slimmer base; if F06 lands first, the new `InputChannel` is one less moving part during F09's task-report extraction. No hard ordering constraint.
- **F22** (sync `fs`): B polls `NoteManager` once per LLM turn instead of once per tool batch — strictly cheaper than today's dispatcher poll for batches that contain multiple tools. The new `NoteChannel.drain()` is the single chokepoint F22 should target when migrating note reads to `fs/promises`. Recommend ordering F06 **before** F22 so that F22 has one place to async-ify rather than two.
- **F08** (legacy runtime-state mirror): unrelated implementation-wise; both B and F08 are in the "delete compatibility cruft" theme, which strengthens the case for the no-backward-compat stance, but they share no code.
