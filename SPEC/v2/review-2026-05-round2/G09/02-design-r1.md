# G09 — Design r1

**Finding**: [../G09-planner-plan-complete-text-protocol.md](../G09-planner-plan-complete-text-protocol.md)
**Analysis**: [./01-analysis-r1.md](./01-analysis-r1.md)

Two proposals. A hardens the regex protocol in place. B replaces it with a structured `plan_done(reason)` tool call in the Plan MCP and deletes the regex outright. Recommendation in §3.

---

## Proposal A — Harden the regex + system-prompt + tests

### Shape

Keep the text-protocol contract; make detection and prompt instructions much more forgiving and explicit.

- Replace the regex at [src/agents/planner.ts](../../../../src/agents/planner.ts#L91-L93) with a small `detectPlanComplete(text: string): boolean` helper that:
  - Strips fenced code blocks (` ``` … ``` `) and inline backticks from `text` before scanning, so quoted markers in code/examples do not false-positive.
  - Strips Markdown emphasis runs `**`, `__`, `*`, `_` surrounding bare words.
  - Strips a trailing punctuation set `[.!?:;]` from the candidate token.
  - Case-insensitively matches the token `PLAN_COMPLETE` (or the canonical form `PLAN[_-]COMPLETE`) anchored as the only non-whitespace content on its own line.
- Rewrite the planner system prompt at [prompts/planner.md](../../../../prompts/planner.md#L41-L49) and [prompts/planner.md](../../../../prompts/planner.md#L137) and the startup-message instruction at [src/agents/planner.ts](../../../../src/agents/planner.ts#L172) so all three sources agree on **one** canonical form: a line whose sole content is `PLAN_COMPLETE`, no emphasis, no punctuation, all caps. Resolve the contradiction with the "always call a tool" rule by carving out an explicit exception ("on the success turn — and only then — you may end your turn with text only, containing exactly `PLAN_COMPLETE` on its own line").
- Add a comprehensive test matrix in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) (or a new sibling `planner.complete.test.ts`) covering:
  - Pass: bare marker, `\n\nPLAN_COMPLETE\n\n`, marker on the last line of a multi-line message, marker after a leading thinking block.
  - Pass after normalisation: `**PLAN_COMPLETE**`, `` `PLAN_COMPLETE` ``, `PLAN_COMPLETE.`, lower/mixed case.
  - Fail (correctly): `Objectives met. PLAN_COMPLETE` (prose on same line), marker inside a fenced code block, marker as substring (`PLAN_COMPLETED`, `PLAN_COMPLETELY`).

### Files touched

- [src/agents/planner.ts](../../../../src/agents/planner.ts#L91-L93) — replace regex line with `detectPlanComplete(text)` call; add the helper (≈25 lines) at module bottom.
- [src/agents/planner.ts](../../../../src/agents/planner.ts#L172) — rewrite the startup instruction to agree with the prompt.
- [prompts/planner.md](../../../../prompts/planner.md#L41-L49), [prompts/planner.md](../../../../prompts/planner.md#L137) — rewrite the three completion-rule passages to one consistent canonical form, add an explicit exception to the "always call a tool" rule for the success turn only.
- [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) — extend (or new `planner.complete.test.ts`) with the matrix above. Pure unit tests; no router-side changes.

### Deletion list

- The inline regex `/^\s*PLAN_COMPLETE\s*$/m` at [src/agents/planner.ts](../../../../src/agents/planner.ts#L93). Replaced by `detectPlanComplete`.
- The wording mismatch between the startup message at [src/agents/planner.ts](../../../../src/agents/planner.ts#L172) and the prompt at [prompts/planner.md](../../../../prompts/planner.md#L47); one of the two formulations is removed.
- Nothing else. The nudge block at [src/agents/planner.ts](../../../../src/agents/planner.ts#L107-L116), `MAX_NUDGES`, recovery loop, and dashboard formatter all remain.

### Test impact

- New unit tests on `detectPlanComplete` (≈10 cases, no I/O, no router) and one end-to-end planner test mirroring `planner.nudge.test.ts` that exits via a non-canonical marker (e.g. `**PLAN_COMPLETE**`) and still succeeds.
- Existing `planner.nudge.test.ts` continues to work as-is (the canonical case still matches).
- No build/integration test changes.

### What this does *not* fix

- The "Planner is the only agent with a free-text termination contract" architectural anomaly. The regex is still in the loop and the dashboard still has no first-class "planner completed" event — it would have to keep scraping the assistant text or rely on `result.data.summary === "PLAN_COMPLETE"`.
- The contradiction with "always call a tool" is softened by a carve-out but remains. Some models will still avoid the text-only path on principle.
- Cross-finding G07: a compacted final turn can still drop the marker. Hardening normalisation does not help when the substring is gone entirely.
- Quoted-marker false positive in §3.2 of the analysis is *mitigated* (we strip fenced blocks before scanning) but only by adding new fragile parsing rules. Markdown is not a regular language; any normalisation here will be approximate.

---

## Proposal B — Replace the text protocol with a `plan_done` tool call

### Shape

Add one new MCP tool `plan_done(reason: string)` to the Plan service. The planner signals completion by emitting a `plan_done` tool_use; the runtime detects the call between `runLoop` iterations and exits the planner outer loop with `kind: "success"`. The regex disappears.

Mechanism:

1. **New tool in Plan MCP.** `plan_done(reason)` records `{ requested_at, reason }` on a `PlanService` field `pendingCompletion: { reason: string; requested_at: string } | null`. Returns `{ ok: true, recorded: true }` immediately. Idempotent (calling twice keeps the first reason and re-returns `ok`). The tool deliberately does *not* mutate `plan.json` — completion is a transient runtime signal, not durable plan state.
2. **PlannerAgent consumes it.** Inject the same `PlanService` instance into `PlannerAgent` (it already exists in the agent context for the MCP runtime). After each `runLoop()` return, the outer loop in [src/agents/planner.ts](../../../../src/agents/planner.ts#L73-L122) checks `planService.consumePendingCompletion()` first; if non-null → `return { kind: "success", data: { summary: reason } }`. Otherwise the existing finishReason / nudge branches run unchanged. `consumePendingCompletion` clears the field after read so a restart starts fresh.
3. **Role filter.** Add `plan_done` to the `PLAN_TOOLS` set at [src/agents/base.ts](../../../../src/agents/base.ts#L1084-L1089). Workers are blocked automatically through `WORKER_EXCLUDED_TOOLS` which spreads `PLAN_TOOLS`.
4. **Recovery loop.** The continuous-improvement branch at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L623-L640) currently keys on `result.data.summary === "PLAN_COMPLETE"`. Change it to a structural check: `result.kind === "success" && hasSummary(result.data)`. The summary is now the model-supplied `reason`, not a magic constant; continuous-improvement still re-queues, hard stop still stops when `continuousImprovement` is off.
5. **Dashboard.** Add `plan_done` to the formatter map at [web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts#L627) so the tool_use renders as a first-class "planner completed (reason)" row instead of a generic tool call.
6. **Prompts.** Strip the three "say `PLAN_COMPLETE`" passages from [prompts/planner.md](../../../../prompts/planner.md#L41-L49), [prompts/planner.md](../../../../prompts/planner.md#L137), and [src/agents/planner.ts](../../../../src/agents/planner.ts#L172). Replace with: "When and only when all objectives are verified complete, call `plan_done(reason)`. Do not emit any other completion signal." The "always call a tool" rule is now self-consistent — completion is itself a tool call.

### Files touched

- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) — add `pendingCompletion` field, `plan_done` method, `consumePendingCompletion()`, dispatch case in the `case "plan_done":` branch around [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L388), and the tool schema in `getToolSchemas()` around [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L475-L487). ≈35 lines net.
- [src/agents/planner.ts](../../../../src/agents/planner.ts) — replace the regex line at [src/agents/planner.ts](../../../../src/agents/planner.ts#L91-L93) with the `consumePendingCompletion()` check; delete the import-side nothing; pass `planService` into the constructor (the agent context already gives access to the runtime, so this is one resolve call in `create()`).
- [src/agents/base.ts](../../../../src/agents/base.ts#L1084-L1089) — add `"plan_done"` to `PLAN_TOOLS`.
- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L619-L650) — replace literal `"PLAN_COMPLETE"` discriminator with structural-success discriminator; log message updates from `PLAN_COMPLETE detected` to `planner completed` to remove the magic-string leak.
- [prompts/planner.md](../../../../prompts/planner.md#L41-L49), [prompts/planner.md](../../../../prompts/planner.md#L137) — rewrite the three completion-rule passages around the tool call.
- [src/agents/planner.ts](../../../../src/agents/planner.ts#L172) — rewrite the startup-message instruction around `plan_done`.
- [web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts) — add a `plan_done` formatter entry.
- [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) — update the success path to drive completion via a `plan_done` tool_call instead of literal text. Add a new test asserting the regex path no longer succeeds (`"PLAN_COMPLETE"` alone in `content` does **not** end the planner — only the tool call does). Preserve the F14 invariant about message non-duplication on the nudge branch.
- [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) — add a `plan_done` round-trip test asserting `consumePendingCompletion` returns the recorded reason once and `null` afterwards.

### Deletion list

- The `/^\s*PLAN_COMPLETE\s*$/m.test(text)` line at [src/agents/planner.ts](../../../../src/agents/planner.ts#L91-L93).
- The `result.data.summary === "PLAN_COMPLETE"` literal discriminator at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L623).
- All three "respond with `PLAN_COMPLETE`" instruction passages in [prompts/planner.md](../../../../prompts/planner.md#L41-L49), [prompts/planner.md](../../../../prompts/planner.md#L137), and the startup message at [src/agents/planner.ts](../../../../src/agents/planner.ts#L172).
- The log strings `PLAN_COMPLETE detected` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L625), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L635).
- The comment block at [src/agents/planner.ts](../../../../src/agents/planner.ts#L89-L93) explaining the regex.

No backward-compatibility shim (per the architecture-first guideline). The string `PLAN_COMPLETE` is no longer a contract; if a future model emits it as plain text, it is ignored and the nudge branch fires.

### Test impact

- `planner.nudge.test.ts`: success-path test rewritten to drive a `plan_done` tool_use through the mock router; the old literal-text exit is replaced. Adds one negative test (literal text does not succeed) and re-asserts F14's message-duplication invariant on the nudge path.
- `runtime.test.ts`: ≈1 new test for `PlanService.plan_done` / `consumePendingCompletion`.
- `plan-server.ts` schema tests (if any): updated to include `plan_done` in the tool count.
- No changes to other agent tests, compaction tests, or end-to-end tests.

### What this does *not* fix

- A buggy model that calls `plan_done` prematurely will exit the planner early. This is the same risk as the current regex (a model that "thinks" it's done already triggers completion); the structured tool surfaces the reason on the dashboard so an operator notices.
- The recovery loop still restarts the planner after `recoveryDelayMs` on any non-success exit. That behaviour is unchanged and not in scope here.
- Cross-finding G04 (Manager hardcoded final-response validation) is a separate text-protocol leak in another agent. This design retires the Planner-side leak only.

---

## 3. Recommendation

**Adopt B.**

The finding's own remediation direction asks for a tool call. The workspace's architecture-first guideline (no preservation of structures that no longer hold) makes A — patching a regex contract that every other agent in v2 has already retired — the explicitly disallowed shape. B is also smaller in net code than the analysis suggests once the nudge block is left alone: ≈35 lines added in the Plan MCP, ≈3 lines changed in PlannerAgent, ≈5 in bootstrap, ≈8 in tests; deletions in prompts and planner balance the budget.

Concrete caveats for the implementer:

1. `plan_done` must be transient runtime state (a `PlanService` field), **not** a write to `plan.json`. Completion is a per-run signal; persisting it would corrupt restart semantics. `consumePendingCompletion()` must clear the field on read.
2. Per workspace handoff, all three v2 containers (`saivage` 10.0.3.111, `diedrico` 10.0.3.113, `saivage-v3` 10.0.3.112) share `/home/salva/g/ml/saivage` as a bind mount. A rebuild updates the binary in all three; only `saivage-v3` is the v2-on-v3 harness target for validation. Restart `saivage.service` on `saivage-v3` only; restarting `saivage` or `diedrico` is out of scope for this finding and must be operator-approved.
3. The F14 message-duplication invariant in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L113-L155) must be preserved verbatim by the rewritten test. F14 is the only nudge-path regression we have on file and it is independent of the success protocol.
4. Do not name the tool `plan_complete`. That name already collides with `plan_complete_stage` at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L197-L198) and would cause a confusing tool-name autocomplete clash in prompts and dashboards. `plan_done` is unambiguous.
