# F14 — Design (R2)

## Changes from r1

- Corrected BaseAgent line references in both proposals. The terminal assistant push is at [src/agents/base.ts](../../../../src/agents/base.ts#L266), the success-path return is at [src/agents/base.ts](../../../../src/agents/base.ts#L283), and `protected messages` is at [src/agents/base.ts](../../../../src/agents/base.ts#L135).
- Tightened the wording about what the duplicate actually pushes. The two pushes are not byte-identical when `response.reasoning` is set — see analysis r2 §Actual differences for the shape table. The proposals themselves do not change.
- No design-shape change. Recommendation is still Proposal B, fallback Proposal A.

Two proposals. The defect is small and the fix is mechanical; the real design question is whether F14 ships as a one-line standalone or is absorbed into F09's `WorkerAgent` extraction.

## Proposal A — Localized fix: delete the manual `messages.push` lines

Delete the duplicate pushes at their two call sites and rely on `BaseAgent.runLoop()`'s existing terminal push at [src/agents/base.ts](../../../../src/agents/base.ts#L266).

### Scope (files touched)

- [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L121): delete the line `this.messages.push({ role: "assistant", content: text });` inside `review()`. The surrounding `this.reviewCount++` and `finishReason` branches at [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L122-L128) stay.
- [src/agents/planner.ts](../../../../src/agents/planner.ts#L232): delete the line `this.messages.push({ role: "assistant", content: text });` immediately above the nudge `injectMessage(...)` call inside the nudge branch.

### What gets added / removed

- Removed: 2 lines (1 per file).
- Added: nothing in production code.
- New regression tests added in the plan (see [03-plan-r2.md](03-plan-r2.md)).

### Risk

Very low. The success-path assistant message is unconditionally pushed by `runLoop()` at [src/agents/base.ts](../../../../src/agents/base.ts#L266) before it returns; removing the manual duplicates preserves the post-call message-log state exactly (one copy instead of two). The abort / cancelled / max-compactions / error branches do not enter the no-tool push branch in `runLoop()`, but in those cases:

- `text` is a synthetic error/abort string, not a real assistant turn.
- The reviewer returns immediately with a non-success `AgentResult` (kind `"abort"` or `"failure"`), so its previous behaviour of also appending the synthetic string to `this.messages` was already redundant — nothing downstream reads it before the reviewer instance is reused.
- The planner's nudge branch only fires on the success-path (text-only response with no tools); it cannot fire on abort/error.

So deleting both lines is behaviourally a no-op on every non-success branch and a strict deduplication on the success branch.

### What it enables

- Closes F14 in isolation, unblocking it from F09's larger refactor schedule.
- Does **not** address the deeper smell flagged in [F14-reviewer-double-push.md](../F14-reviewer-double-push.md): "BaseAgent owns the message log but subclasses occasionally reach in". Subclasses can still touch `this.messages` directly because the field is `protected` at [src/agents/base.ts](../../../../src/agents/base.ts#L135). Future regressions of the same shape remain possible.

### What it forbids

Nothing structural. This is a defect fix.

### Recommendation note

Right-sized fix if F09 is judged too far out to absorb F14. If F09 is on track for the same review cycle, prefer Proposal B to avoid touching `reviewer.ts` twice.

---

## Proposal B — Absorb F14 into F09's `WorkerAgent` extraction (recommended)

F09 Proposal C already rewrites `ReviewerAgent.review()` to flow through a shared `WorkerAgent.executeTask()` body that consumes `runLoop()`'s returned `text` without re-pushing it; the reviewer L121 duplicate is deleted as a documented side-effect. F14 then reduces to "the planner half" — one line in `planner.ts`.

### Scope (files touched)

- **Reviewer half**: no F14-specific change. F09 ([F09/02-design-r2.md](../F09/02-design-r2.md)) §"After-state per worker → reviewer" already states: "The duplicate assistant push at [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L121) is removed. The terminal assistant message is already pushed by `BaseAgent.runLoop()` at [src/agents/base.ts](../../../../src/agents/base.ts#L266); the manual push was a double-write bug (F14 / subsystem-map note)." F14 is closed for the reviewer by F09's commit.
- **Planner half**: a single-line deletion in [src/agents/planner.ts](../../../../src/agents/planner.ts#L232), shipped either inside F09's commit or as a trailing follow-up. The planner is not a worker and is out of F09's `WorkerAgent` scope, so the one-line planner fix has to land somewhere; the cleanest home is the F14 commit (containing just that one deletion and the regression test below).

### What gets added / removed

- Removed (under F09): the reviewer L121 line (already counted in F09's net-line accounting).
- Removed (under F14): the planner L232 line.
- Added: two regression tests (see [03-plan-r2.md](03-plan-r2.md)) asserting:
  - After `ReviewerAgent.review()` returns successfully, the final assistant text appears exactly once in the agent's conversation log.
  - After a planner nudge cycle, the assistant text appears exactly once in the conversation log immediately before the nudge user message.

### Risk

Low. The reviewer change is already covered by F09's risk analysis. The planner one-liner is mechanical and preserves the nudge-path semantics described in analysis r2 §Constraints #3.

### What it enables

- Stops F14 and F09 from racing on the same file (`reviewer.ts`).
- Pairs the deletion with F09's enforcement of "subclasses never touch `this.messages` directly" by virtue of the `executeTask()` boundary; the reviewer no longer has any reason to know `messages` exists.
- Leaves a clear cross-reference between F09 and F14 in the audit history.

### What it forbids

- F14 (under Proposal B) cannot ship before F09 — its reviewer half depends on F09's `executeTask()` being in place. If schedule pressure flips, fall back to Proposal A.

### Recommendation note

This is the cleanest sequencing: F09 already does the structurally-right thing for the reviewer; tacking on the one-line planner fix as F14's payload keeps both audit trails honest without double-editing `reviewer.ts`.

---

## Recommendation

**Proposal B**, conditional on F09 landing first (or in the same change set). F14 then becomes a one-line deletion in `planner.ts` plus regression tests. If F09 slips, fall back to **Proposal A** (two-line deletion); both proposals reach the same end state for `runLoop()`-driven push semantics.
