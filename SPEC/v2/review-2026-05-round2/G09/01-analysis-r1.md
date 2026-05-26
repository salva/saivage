# G09 — Analysis r1

**Finding**: [../G09-planner-plan-complete-text-protocol.md](../G09-planner-plan-complete-text-protocol.md)
**Subsystem**: src/agents/ (Planner termination protocol)
**Round-1 reference**: F14 (PlannerAgent message duplication on nudge); cross-couples to G07 (compaction fallback).

## 1. Where the regex lives and what it matches

The completion check is a single line at [src/agents/planner.ts](../../../../src/agents/planner.ts#L91-L93):

```ts
if (/^\s*PLAN_COMPLETE\s*$/m.test(text)) {
  return { kind: "success", data: { summary: "PLAN_COMPLETE" } };
}
```

Inputs to the regex:

- `text` comes from `runLoop()`'s zero-tool-call branch at [src/agents/base.ts](../../../../src/agents/base.ts#L271-L297). It is `response.content` verbatim from `router.chat`. There is no normalization — `text` is the raw assistant `content` string before any tool-result processing, exactly what the model emitted.
- `finishReason` is `response.finishReason` (typically `"end_turn"`). The regex check only runs when `finishReason` is neither `"abort" | "cancelled" | "max_compactions" | "error"`, so it covers `"end_turn"` and anything else that falls through.

Regex semantics:

- `^…$` with the `m` flag anchors to a line. So the marker must occupy an entire line (after whitespace strip via `\s*` on both sides).
- `\s` is JS-flavoured: includes spaces, tabs, `\n`, `\r`, `\f`, `\v`, U+00A0, etc. So `"PLAN_COMPLETE\u00A0"` on its own line still matches.
- Case-sensitive (no `i` flag).
- No multiline body content stripping: a line *inside a fenced code block* whose body is exactly `PLAN_COMPLETE` will match. So will a line inside a quoted block (`> PLAN_COMPLETE`) — actually no, the `>` is non-whitespace and breaks the `^\s*PLAN_COMPLETE\s*$` anchor. But a fenced ```` ```PLAN_COMPLETE ```` line matches because there is no `>` in front.

## 2. What the prompt asks for

Three places instruct the model to emit the marker — they do not all agree:

- The startup user message constructor at [src/agents/planner.ts](../../../../src/agents/planner.ts#L172): *`6. Only respond with "PLAN_COMPLETE" when objectives are verified ...`*. Quotes the literal string but does not specify casing, isolation, or that it must be the sole content of the line.
- The system prompt rule at [prompts/planner.md](../../../../prompts/planner.md#L47): *`5. If truly everything is done, say exactly "PLAN_COMPLETE" on its own line.`*. This one matches the regex semantics.
- The same prompt at [prompts/planner.md](../../../../prompts/planner.md#L49) and [prompts/planner.md](../../../../prompts/planner.md#L137) reiterates the rule but again does not insist on "no other text on the line".

So the model gets three reminders, of which two leave room for the violations enumerated below.

## 3. Failure modes of the current detector

### 3.1 Model-side variations that miss

- **Markdown emphasis**: `**PLAN_COMPLETE**`, `__PLAN_COMPLETE__`, `` `PLAN_COMPLETE` `` on their own line. All fail (`*`, `_`, `` ` `` are not whitespace).
- **Trailing punctuation**: `PLAN_COMPLETE.` or `PLAN_COMPLETE!` — fail.
- **Leading prose on the same line**: `Objectives met. PLAN_COMPLETE` — fails (the `^\s*` anchor sees `Objectives`).
- **Trailing prose on the same line**: `PLAN_COMPLETE — all stages green` — fails.
- **Casing drift**: `plan_complete`, `Plan_Complete`, `PLAN-COMPLETE` — all fail. Smaller open models are most prone to this.
- **Wrapped in a fenced code block as a status banner** (`` ```PLAN_COMPLETE``` `` on one line): the inner line `PLAN_COMPLETE` *would* match if the code fence is multi-line; an inline triple-backtick single-line form has `` ``` `` on either side and fails.

Each of these triggers a nudge loop. With `MAX_NUDGES = 15` at [src/agents/planner.ts](../../../../src/agents/planner.ts#L21) the planner eventually returns `{ kind: "failure", reason: "Planner stalled after 15 nudges without progress" }`. The recovery loop in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L644-L655) treats this as a recoverable end and restarts after `recoveryDelayMs`, so the planner spins indefinitely with no progress and no signal that the *protocol* (not the work) is the problem.

### 3.2 False positives

- **Marker inside a fenced code block** intended as a quoted example (e.g. the planner explaining the protocol to itself or a future agent): if the inner line is bare `PLAN_COMPLETE`, it matches. The model can therefore self-terminate by reasoning about completion without actually deciding it.
- **Marker echoed back from a tool result that got summarized into the assistant text** (cross-finding G07): the compaction fallback may include the literal token in its summary. The summary text is later appended back as `user` content, but if a future assistant turn paraphrases the summary and re-emits the token on its own line, the protocol triggers.

### 3.3 Interaction with `runLoop` and `finishReason`

The regex check only runs when `runLoop` returns *without* `finishReason ∈ { abort, cancelled, max_compactions, error }`. In particular it runs on `end_turn`. There is no requirement that the assistant emitted zero tool calls — but `runLoop` only returns the assistant text branch when `response.toolCalls.length === 0` at [src/agents/base.ts](../../../../src/agents/base.ts#L272). So in practice completion requires:

1. Model emits an assistant turn with no tool calls.
2. The turn's `content` contains a line matching the regex.

Combined with the system prompt rule at [prompts/planner.md](../../../../prompts/planner.md#L41-L48) — *"Every single turn you MUST call at least one tool."* — the contract is internally contradictory: "always call a tool" vs "the only way to succeed is to end a turn with text and no tool". Models trained to obey the strong "always call a tool" instruction will avoid the success path, requiring the nudge loop to escape.

### 3.4 Compaction interaction (G07 cross-link)

Compaction can fire after the model's final assistant turn lands but before `runLoop` returns the text branch — actually no: compaction runs at the start of each iteration in [src/agents/base.ts](../../../../src/agents/base.ts#L237-L249), so the *next* `router.chat` call may be on a compacted history. The marker is in the previous assistant turn; if the planner's outer loop nudges and we re-enter `runLoop`, the assistant marker may have been summarized away. The summary is a plain text `user` message ([src/runtime/compaction.ts](../../../../src/runtime/compaction.ts)), and the model is then expected to re-emit the marker from scratch. Anecdotally this is exactly when models paraphrase ("Objectives are complete — PLAN_COMPLETE.") and trigger §3.1.

### 3.5 Test coverage

[src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) drives the planner through the nudge branch and exits via a literal `"PLAN_COMPLETE"` content string at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L92). The test does not vary casing, surrounding text, code-fence wrapping, or trailing punctuation — every §3.1 failure is unprotected. There is no test for the false-positive cases in §3.2 either.

## 4. Why text-protocol is the wrong shape here

- Every *other* terminal signal in v2 is structured. Manager returns `StageSummary`, Worker returns `TaskReport`, Inspector returns `InspectionReport`, all parsed against Zod schemas via `parseLlmJsonAs`. The Planner is the lone agent whose success is decided by regexing free text.
- The Plan MCP service in [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L1-L220) already owns the plan lifecycle (`plan_init`, `plan_add_stage`, `plan_complete_stage`, …). It is the natural carrier for a `plan_done(reason)` tool — registering one more tool there is a 30-line patch and gives the dashboard, runtime supervisor, and recovery loop the same observable event the regex was trying to scrape from the message text.
- The system prompt's strongest rule (`prompts/planner.md` §"CRITICAL RULE — ALWAYS TAKE ACTION", lines 41–48) is *"never end a turn with only text; always call a tool"*. The current termination contract directly violates that rule. A tool-call termination harmonises the two.
- The nudge text block at [src/agents/planner.ts](../../../../src/agents/planner.ts#L107-L116) is 10 lines of corrective instructions whose only purpose is to recover from a missed marker. With a structured tool, the equivalent failure ("planner ended turn with text only") is the same nudge we already have — the marker branch disappears entirely.

## 5. What a tool-call protocol must preserve

If the regex is replaced with `plan_done(reason)`:

1. The recovery loop in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L619-L650) currently keys on `result.kind === "success" && result.data.summary === "PLAN_COMPLETE"`. It must instead key on the `success` shape produced when the tool was called (carrying the model-supplied `reason`).
2. Continuous-improvement mode at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L631-L640) must still re-queue the planner after completion. The discriminator is currently the literal `"PLAN_COMPLETE"` string in `result.data.summary`; with a tool, the discriminator becomes "did the planner emit a `plan_done` tool_use this run?". Reason text is informational only.
3. The dashboard at [web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts) currently has no `PLAN_COMPLETE` event to render. Adding one (`plan_done`) requires a single entry in the formatter map alongside the other `plan_*` tools.
4. `plan_done` must be planner-only. The role filter at [src/agents/base.ts](../../../../src/agents/base.ts#L1085-L1120) has a `PLAN_TOOLS` allow-list referenced from the `planner` filter and a `WORKER_EXCLUDED_TOOLS` block-list referenced from worker filters. Adding `plan_done` to `PLAN_TOOLS` gives both: planner allowed, workers blocked.

## 6. Cross-links

- **G04** — manager validates final response against a hardcoded tool list. Same architectural shape (text-protocol contract bolted onto a structured-tool agent) and the fix family is identical. The two should ship as a coordinated pair to avoid re-asserting the rule twice in different syntaxes.
- **G07** — compaction fallback can drop the marker. Closing this finding with a tool call retires that failure mode entirely: the `plan_done` tool_use is a structural assistant block that the compaction round-parser preserves as part of its `ToolRound`, not a substring that can be summarised away.
- **F14** — PlannerAgent message duplication on the nudge branch. The nudge branch survives this finding (we still nudge when the planner ends turn with text and no tool calls). The F14 invariant must be re-asserted in the new tests.
- **G11** — chat restart regex is English-only. Same family (regex-on-LLM-text protocol). Not blocking but the metaplan should batch these as "free-text protocols to retire".
