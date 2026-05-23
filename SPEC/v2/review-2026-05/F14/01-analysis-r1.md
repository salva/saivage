# F14 — Analysis (R1)

## Problem restated

`BaseAgent.runLoop()` already pushes the terminal no-tool assistant response into `this.messages` before returning the text to its caller. Two subclasses then push the same text again:

- `ReviewerAgent.review()` pushes once per call on every dispatch: [src/agents/reviewer.ts](src/agents/reviewer.ts#L121).
- `PlannerAgent.run()` pushes once per nudge cycle when the planner ended its turn without `PLAN_COMPLETE`: [src/agents/planner.ts](src/agents/planner.ts#L232).

The `runLoop()` push is unconditional on the success path:

- The no-tool branch builds `assistantContent` (text or `thinking + text`) and pushes it via `this.pushMessage({ role: "assistant", content: assistantContent }, ...)` at [src/agents/base.ts](src/agents/base.ts#L268-L269), and only then returns the same `response.content` to the caller at [src/agents/base.ts](src/agents/base.ts#L286).
- The shared mutator is [src/agents/base.ts](src/agents/base.ts#L727-L731) (`pushMessage`), which just appends to `this.messages`.

So whenever `runLoop()` finishes with `finishReason !== "abort" | "cancelled" | "max_compactions" | "error"` (i.e. a normal end-of-turn text response), the caller already has the message in `this.messages`. The reviewer's and planner's extra `this.messages.push({ role: "assistant", content: text })` duplicate that message.

The same code also runs on abort / failure paths in the reviewer because the manual push at L121 is unconditional with respect to `finishReason` — it sits above the `finishReason` checks. On abort/cancelled, `runLoop()` returns `text` from a synthesised error string (e.g. the abort reason) and does NOT call the no-tool push branch, so the reviewer's push is the ONLY push and is harmless in those cases. The duplicate fires only on the success/normal-end-of-turn branch — which is the common case for the reviewer.

## Actual differences

The two manual pushes and the `runLoop()` push are byte-identical for the success case:

| Site | Content pushed |
| --- | --- |
| `base.ts` L268-L269 (success) | `response.content` (possibly wrapped with `thinking` block) |
| `reviewer.ts` L121 (always) | `text` returned by `runLoop()` — which IS `response.content` for the success branch |
| `planner.ts` L232 (nudge) | `text` returned by `runLoop()` — same |

For the reviewer, the duplicate inflates the conversation by one full assistant turn per dispatch. For long-running stage reviews where `review(input)` is called 3-6 times by the manager, the reviewer's transcript contains 3-6 byte-identical duplicated assistant blocks before compaction even has a chance to look at it.

For the planner, the duplicate is one assistant message per nudge cycle (`MAX_NUDGES = 15`). The planner's nudge path is rare (only when the planner stops without calling a tool), but every occurrence doubles the assistant text in-context.

## Contract

`BaseAgent.runLoop()` owns the conversation log and is the only code path that should append loop-produced messages. Its contract is:

- Inputs: pre-seeded `this.messages` (system prompt and initial user message wired up in the constructor).
- Side effects: appends every `{role: "assistant"}` and `{role: "user", content: tool_result}` block emitted by the loop, including the final no-tool assistant response. Appends repair / nudge user messages when `validateFinalResponse()` rejects.
- Return value: `{ text, finishReason, source? }` where `text` is the final assistant text (already pushed into `this.messages`) and `finishReason` carries the lifecycle outcome.

Subclasses are expected to consume `text` and `finishReason` to drive role-specific control flow (parse a `TaskReport`, decide whether to continue planning, etc.); they are not expected to manage the message log.

## Call sites & dependencies

- `ReviewerAgent.review()` is called twice in the stage lifecycle: once via `run()` (the manager's initial dispatch path through `bootstrap.ts` worker dispatcher) and N additional times by `ManagerAgent` when it re-invokes the same reviewer instance with new corrective work. The same `ReviewerAgent` instance is re-used; `this.messages` accumulates across calls; compaction is shared.
- `PlannerAgent.run()` is long-lived; one instance per project lifetime. The nudge branch runs only when the planner ends a turn with text and no tool calls.
- `BaseAgent.runLoop()` is the single shared loop for every agent role: planner, manager, coder, researcher, data-agent, reviewer, inspector, chat, supervisor.

The duplicated content participates in:

- The next `runLoop()` iteration's `provider.chat({ messages: this.messages, ... })` (see [src/providers/types.ts](src/providers/types.ts#L30)).
- `summariseAndReplaceMessages` in [src/runtime/compaction.ts](src/runtime/compaction.ts#L86) — the duplicate counts double against the token estimator and contributes twice to the summary.
- `RuntimeState` chatlog persistence (only its byte count, not its semantics — the chatlog is rendered per-message and the duplicate would render twice).

There are no other consumers of `this.messages` that depend on the duplicate; nothing keys off "the same text appears twice". Removing the duplicates does not break any observed call site.

## Constraints any solution must respect

1. **Project guideline — no backward compatibility / no shims.** Delete the duplicate; do not gate it behind a flag.
2. **Reviewer's `review()` second-call semantics must keep working.** The reviewer needs `this.messages` to contain the previous review text when `ManagerAgent` re-invokes `review(input)` so the follow-up review can compare against prior findings. After removing the duplicate, the message log still contains exactly one copy of the prior review text (placed there by `runLoop()` L268-L269 during the previous call), so the second-call semantics are preserved.
3. **Planner nudge path must keep its current control flow.** The planner deliberately appends a user-role nudge (`injectMessage(...)`) after the assistant turn so the model sees its own answer followed by the instruction to do better. After removing the duplicate, the assistant turn is still in `this.messages` (from `runLoop()`), and `injectMessage` continues to append the nudge after it. Semantics preserved.
4. **No regression in compaction.** Compaction runs on `this.messages` at the start of each `runLoop()` iteration. Removing duplicates strictly reduces tokens; it cannot cause new compaction-related failures.
5. **Out of scope.** `src/skills/`, `SPEC/v2/skills-memory/`, `SPEC/v2/skills/`.
6. **Coordination with F09.** F09 Proposal C (`WorkerAgent extends BaseAgent`) explicitly removes the reviewer L121 duplicate as part of rewriting `review()` to flow through a shared `executeTask()` body that relies on `runLoop()`'s push. The plan for F14 must declare whether it lands independently or is absorbed into F09. See cross-link in §Design.

## Cross-links

- **F09** — `WorkerAgent`/task-report extraction. F09's Proposal C ([F09/02-design-r2.md](F09/02-design-r2.md)) calls out the reviewer L121 removal explicitly as "the only behaviour change `ReviewerAgent` undergoes". If F09 lands first, the reviewer half of F14 disappears.
- **Subsystem map**: §2 ("Agents") boundary observation #3 — "BaseAgent owns the assistant push, but `ReviewerAgent.review` pushes another `{role: "assistant"}` message" ([00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md)).
