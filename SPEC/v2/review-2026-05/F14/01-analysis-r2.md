# F14 — Analysis (R2)

## Changes from r1

- Corrected stale BaseAgent line references throughout. Verified against [src/agents/base.ts](../../../../src/agents/base.ts): the no-tool assistant `pushMessage` is at line 266 (not L268-L269), the success-path `return` is at line 283 (not L286), `messages` is protected at line 135 (not L131), and the `pushMessage` helper begins at line 718 (not L727-L731).
- Replaced the "byte-identical duplicate" wording with an accurate description of what the two pushes actually store. When `response.reasoning` is present, `runLoop()` pushes a `ContentBlock[]` containing a `thinking` block plus a `text` block; the subclass push at [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L121) and [src/agents/planner.ts](../../../../src/agents/planner.ts#L232) stores only the plain `text` string returned by `runLoop()`. The visible assistant text is the same in both pushes (so model context sees the line of reasoning's text twice), but the message payloads are not byte-identical. The bug is still real, the wording is just more precise.

## Problem restated

`BaseAgent.runLoop()` already pushes the terminal no-tool assistant response into `this.messages` before returning the text to its caller. Two subclasses then push the same final assistant turn a second time:

- `ReviewerAgent.review()` pushes once per call on every dispatch: [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L121).
- `PlannerAgent.run()` pushes once per nudge cycle when the planner ended its turn without `PLAN_COMPLETE`: [src/agents/planner.ts](../../../../src/agents/planner.ts#L232).

The `runLoop()` push is unconditional on the success path:

- The no-tool branch builds `assistantContent` (either a plain string `response.content`, or a `ContentBlock[]` with a `thinking` block plus a `text` block when `response.reasoning` is set) and pushes it via `this.pushMessage({ role: "assistant", content: assistantContent }, ...)` at [src/agents/base.ts](../../../../src/agents/base.ts#L260-L266). Only then does it return the same `response.content` to the caller at [src/agents/base.ts](../../../../src/agents/base.ts#L283).
- The shared mutator is `pushMessage` at [src/agents/base.ts](../../../../src/agents/base.ts#L718), which just appends to `this.messages`.

So whenever `runLoop()` finishes through the no-tool branch and `validateFinalResponse()` passes (i.e. a normal end-of-turn text response that becomes the agent's result), the caller already has the message in `this.messages`. The reviewer's and planner's extra `this.messages.push({ role: "assistant", content: text })` duplicate that message.

The reviewer push at [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L121) is unconditional with respect to `finishReason` — it sits above the `finishReason` checks at [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L123-L128). On `abort` / `cancelled` / `max_compactions` / `error`, `runLoop()` returns from a branch that does NOT execute the no-tool push (it returns a synthesized error/abort string from elsewhere in [src/agents/base.ts](../../../../src/agents/base.ts#L218-L246)), so the reviewer's push is the ONLY push and is harmless on those paths. The duplicate fires only on the success branch — which is the common case.

For the planner, the duplicate at [src/agents/planner.ts](../../../../src/agents/planner.ts#L232) sits inside the nudge branch, which only runs after a normal no-tool success-path return from `runLoop()`; so on that path `runLoop()` always pushed first.

## Actual differences

The two manual pushes and the `runLoop()` push are equivalent in visible assistant text for the success case, with a subtle shape difference when reasoning is present:

| Site | Content pushed | Shape when `response.reasoning` is set | Shape otherwise |
| --- | --- | --- | --- |
| [src/agents/base.ts](../../../../src/agents/base.ts#L266) (success) | `assistantContent` | `ContentBlock[]` = `[thinking, text]` | `string` (`response.content`) |
| [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L121) (always) | `text` returned by `runLoop()` | plain `string` (the text only) | plain `string` |
| [src/agents/planner.ts](../../../../src/agents/planner.ts#L232) (nudge) | `text` returned by `runLoop()` | plain `string` (the text only) | plain `string` |

For the reviewer, the duplicate inflates the conversation by one full assistant turn per dispatch. For long-running stage reviews where `review(input)` is called 3-6 times by the manager, the reviewer's transcript contains 3-6 duplicated assistant text blocks before compaction even has a chance to look at them. When the model is on a reasoning provider, the duplicate strips the `thinking` block (the subclass push is text-only), so the second copy reads as a context-free repetition of the same final answer.

For the planner, the duplicate is one assistant message per nudge cycle (`MAX_NUDGES = 15`). The nudge path is rare (only when the planner stops without calling a tool), but every occurrence doubles the assistant text in-context.

## Contract

`BaseAgent.runLoop()` owns the conversation log and is the only code path that should append loop-produced messages. Its contract is:

- Inputs: pre-seeded `this.messages` (system prompt and initial user message wired up in the constructor; see [src/agents/base.ts](../../../../src/agents/base.ts#L199-L205)).
- Side effects: appends every `{role: "assistant"}` and `{role: "user", content: tool_result}` block emitted by the loop, including the final no-tool assistant response at [src/agents/base.ts](../../../../src/agents/base.ts#L266). Appends model-repair user messages when `validateFinalResponse()` rejects at [src/agents/base.ts](../../../../src/agents/base.ts#L277-L280).
- Return value: `{ text, finishReason, source? }` where `text` is the final assistant text (already pushed into `this.messages` on the success path) and `finishReason` carries the lifecycle outcome.

Subclasses are expected to consume `text` and `finishReason` to drive role-specific control flow (parse a `TaskReport`, decide whether to continue planning, etc.); they are not expected to manage the message log.

## Call sites & dependencies

- `ReviewerAgent.review()` is called twice in the stage lifecycle: once via `run()` (the manager's initial dispatch through the worker dispatcher) and N additional times by `ManagerAgent` when it re-invokes the same reviewer instance with new corrective work. The same `ReviewerAgent` instance is re-used; `this.messages` accumulates across calls; compaction is shared.
- `PlannerAgent.run()` is long-lived; one instance per project lifetime. The nudge branch runs only when the planner ends a turn with text and no tool calls.
- `BaseAgent.runLoop()` is the single shared loop for every agent role: planner, manager, coder, researcher, data-agent, reviewer, inspector, chat, supervisor.

The duplicated content participates in:

- The next `runLoop()` iteration's `provider.chat({ messages: this.messages, ... })` (see [src/providers/types.ts](../../../../src/providers/types.ts#L30)).
- `summariseAndReplaceMessages` in [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L86) — the duplicate counts double against the token estimator and contributes twice to the summary input.
- `RuntimeState` chatlog persistence (only its byte count and per-message render, not its semantics).

There are no other consumers of `this.messages` that depend on the duplicate; nothing keys off "the same text appears twice". Removing the duplicates does not break any observed call site.

## Constraints any solution must respect

1. **Project guideline — no backward compatibility / no shims.** Delete the duplicate; do not gate it behind a flag.
2. **Reviewer's `review()` second-call semantics must keep working.** The reviewer needs `this.messages` to contain the previous review text when `ManagerAgent` re-invokes `review(input)` so the follow-up review can compare against prior findings. After removing the duplicate, the message log still contains exactly one copy of the prior review text (placed there by `runLoop()` at [src/agents/base.ts](../../../../src/agents/base.ts#L266) during the previous call), so the second-call semantics are preserved. This is already implicitly exercised by the existing test in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L91-L145), which asserts that the first review's report text is visible in the second review's request — that test continues to pass with one copy instead of two.
3. **Planner nudge path must keep its current control flow.** The planner appends a user-role nudge via `injectMessage(...)` after the assistant turn so the model sees its own answer followed by the instruction to do better. After removing the duplicate, the assistant turn is still in `this.messages` (from `runLoop()`), and `injectMessage` continues to append the nudge after it. Semantics preserved.
4. **No regression in compaction.** Compaction runs on `this.messages` at the start of each `runLoop()` iteration. Removing duplicates strictly reduces tokens; it cannot cause new compaction-related failures.
5. **`messages` is `protected` on `BaseAgent`.** [src/agents/base.ts](../../../../src/agents/base.ts#L135) declares it `protected messages: Message[]`. Subclass code can write to it (which is exactly how the bug arose). Test code in a sibling file cannot read it through a typed reference without an explicit cast or a public accessor. Any regression test must respect this — see plan for the chosen inspection strategy.
6. **Out of scope.** `src/skills/`, `SPEC/v2/skills-memory/`, `SPEC/v2/skills/`.
7. **Coordination with F09.** F09 Proposal C (`WorkerAgent extends BaseAgent`) explicitly removes the reviewer L121 duplicate as part of rewriting `review()` to flow through a shared `executeTask()` body that relies on `runLoop()`'s push. The plan for F14 must declare whether it lands independently or is absorbed into F09. See cross-link in §Design.

## Cross-links

- **F09** — `WorkerAgent`/task-report extraction. F09's Proposal C ([F09/02-design-r2.md](../F09/02-design-r2.md)) calls out the reviewer L121 removal explicitly as "the only behaviour change `ReviewerAgent` undergoes". If F09 lands first, the reviewer half of F14 disappears.
- **Subsystem map**: §2 ("Agents") boundary observation #3 — "BaseAgent owns the assistant push, but `ReviewerAgent.review` pushes another `{role: "assistant"}` message" ([00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md)).
