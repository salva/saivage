# G09 — Analysis r3

**Finding**: [../G09-planner-plan-complete-text-protocol.md](../G09-planner-plan-complete-text-protocol.md)
**r1 docs**: [./01-analysis-r1.md](./01-analysis-r1.md), [./02-design-r1.md](./02-design-r1.md), [./03-plan-r1.md](./03-plan-r1.md)
**r2 docs**: [./01-analysis-r2.md](./01-analysis-r2.md), [./02-design-r2.md](./02-design-r2.md), [./03-plan-r2.md](./03-plan-r2.md)
**r2 review**: [./04-review-r2.md](./04-review-r2.md) (CHANGES_REQUESTED, 3 required changes)

r2's structural analysis (§1–§8) is accepted in full and is not re-derived here. r3 only re-examines the three points the reviewer flagged: the live status of `pendingCompletion` after the terminal hook fires, the exclusivity and abort-ordering of the terminal-tool batch, and the executability of the post-condition grep against the negative regression test.

## r3 deltas vs r2

- §A NEW. `PlanService.consumePendingCompletion()` is now part of the success path: r2 added the field and method but never read it. r3 makes the terminal-tool override consume it on success so the in-memory cell is empty when the planner exits.
- §B NEW. The terminal-tool hook is now exclusive on the response batch and runs AFTER the existing abort check, not before it. r2 placed the hook before `if (dispatchResult.aborted)` and matched the first non-error `plan_done` in the batch; r3 reverses the ordering and tightens matching to a single-call batch keyed by `toolUseId`.
- §C NEW. The post-condition grep is now executable as written next to the negative regression test, because the test constructs the legacy token without a contiguous literal.

The §1–§8 reasoning from [./01-analysis-r2.md](./01-analysis-r2.md) stands unchanged for everything else.

## A. Why `pendingCompletion` must be consumed on success

The reviewer's first required change is correct: r2 wires `PlanService` through `AgentContext` (per [./02-design-r2.md](./02-design-r2.md#L84-L110)) and adds `pendingCompletion` / `consumePendingCompletion()` to the service (per [./03-plan-r2.md](./03-plan-r2.md#L17-L36)), but the actual terminal hook in [./02-design-r2.md](./02-design-r2.md#L55-L62) reads `reason` straight out of `tc.input` and never touches the service. The design even states explicitly that the hook does not call `consumePendingCompletion()`.

That leaves stale state behind. Two concrete consequences in the live code:

1. **Continuous-improvement loop.** [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L155-L169) wires a single `PlanService` instance into MCP via a closure; the recovery loop in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L619-L644) re-runs the planner against the same runtime, hence the same `PlanService`. If the first cycle's `plan_done` writes to `pendingCompletion` and the planner exits without clearing it, the second cycle's `plan_done` call falls into the `if (this.pendingCompletion)` branch in [./02-design-r2.md](./02-design-r2.md#L181-L189) and returns `{ ok: true, recorded: false }`. The planner still completes (because the terminal hook trusts the tool call, not the service), but the MCP-level error signal a dashboard or operator would use to spot a regression is silently lost.

2. **Dead wiring.** If the hook is never going to read `ctx.planService`, then adding `planService: PlanService` to `AgentContext` ([src/agents/types.ts](../../../../src/agents/types.ts#L30-L38)) and threading it through every construction site (manager, worker, inspector, chat, plus the planner site at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L155-L169)) is dead context — the planner is the only candidate reader and it doesn't read. That is the kind of "broad refactor for nothing" the architecture-first rule rejects.

The reviewer offered two valid resolutions: consume the pending completion (and keep the wiring), or drop the wiring and the service-side completion API entirely. r3 picks the first because:

- The wiring is the natural symmetry partner of `mcpRuntime`: the MCP path can read/write `pendingCompletion`, and the planner-side terminal path can clear it. Two writers (model via MCP dispatch and runtime via terminal hook) and one in-memory cell, both observing through one `PlanService` instance.
- `pendingCompletion` doubles as the audit trail for the case where the model calls `plan_done` *twice* in one turn (rare but legal under the dispatcher's batching at [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L80-L124)): the first call sets it, the second returns `recorded: false`, and the consume-on-success in the hook clears it exactly once for the recovery loop.
- G04 will need the same symmetry for `manager_done`; r3 establishes the pattern.

The fix is mechanical: the terminal-tool override calls `this.ctx.planService.consumePendingCompletion()` after deciding the call succeeded, uses the consumed `reason` if present (otherwise falls back to the tool's input as a defensive read), and returns `{ name: "plan_done", data: { reason } }`. The reason of record is the one the service stored, because the MCP dispatch path is the only writer that has actually been validated by `PlanService.plan_done()`. A new test in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) asserts that after a successful terminal `plan_done`, `consumePendingCompletion()` on the stub `PlanService` returns `null` (i.e. consumed), and a follow-up direct `plan_done` call records a fresh completion.

## B. Why the terminal hook must be exclusive and run after abort

The reviewer's second required change is correct on two coupled points: ordering vs the existing abort path, and exclusivity of the batch.

### B.1 Ordering — abort wins

The live `BaseAgent.runLoop` in [src/agents/base.ts](../../../../src/agents/base.ts#L327-L346) pushes the `tool_result` user message and then checks `if (dispatchResult.aborted) return { text: "Aborted during tool execution", finishReason: "abort" }`. r2's plan ([./03-plan-r2.md](./03-plan-r2.md#L126-L137)) inserts the terminal-tool check *before* this abort check.

That inversion is wrong. The dispatcher at [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L80-L124) handles a batch where one entry may have been a local `plan_done` that returned an ok payload, and a sibling dispatch entry (a `run_manager`) may have aborted mid-flight, producing `aborted: true` on `DispatchResult`. With r2's ordering the planner would see a non-error `plan_done` result, fire the terminal hook, and return `tool_terminal` — masking the abort that the rest of the runtime was about to act on. The same hazard applies to user-initiated cancellation: abort is the user's primary control surface and must beat every other terminal signal.

Correct ordering: dispatch → push result message → if aborted return abort → only then evaluate the terminal hook.

### B.2 Exclusivity — single-call batches only

The Anthropic / OpenAI protocol allows multiple `tool_use` blocks per assistant turn. The dispatcher separates local and dispatch tools and runs them with different concurrency rules ([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L80-L124)). Nothing prevents a model from emitting `[plan_add_stage, plan_done]` or `[run_manager, plan_done]` in a single response.

Under r2's plan the hook iterates `toolCalls`, picks the first `plan_done` whose corresponding result is non-error ([./02-design-r2.md](./02-design-r2.md#L55-L62)), and returns terminal. That accepts a turn that simultaneously declares the project complete and schedules more work. It is the same family of fragile model-protocol trust the finding aims to remove.

Stricter rule: the planner completes if and only if the entire response was a single `plan_done` tool call whose result is non-error. Concretely:

- `toolCalls.length === 1`, AND
- `toolCalls[0].name === "plan_done"`, AND
- `dispatchResult.toolResults` contains an entry with `toolUseId === toolCalls[0].id` and `isError === false`.

Any other shape — any sibling tool call, any error/abort result for the `plan_done` entry — leaves the loop to continue. The nudge / max-nudges / recovery paths already handle "planner emitted other tools": dispatch their results, iterate, and either reach a terminal hook on a subsequent turn or fall through to nudge.

The toolUseId match is necessary because `dispatchResult.toolResults` is *not* guaranteed to be index-aligned with `toolCalls`. The dispatcher in [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L80-L124) splits the input list into local and dispatch buckets and pushes their results back in arrival order; for a single-call batch the order is trivial, but the hook should not rely on it. Keying by `toolUseId` is correct for the general case and free for the single-call case.

This restriction is enforceable in the override alone — no `BaseAgent` changes beyond r2. It also collapses cleanly with §A: when the batch is the single-call shape, the hook consumes `pendingCompletion`, otherwise it returns `null` and the cell stays as-written by MCP for the next iteration to observe.

## C. Why the grep and the negative test must be reconciled

The reviewer's third required change is correct. r2 requires `grep -rn PLAN_COMPLETE src/ prompts/` to return zero ([./03-plan-r2.md](./03-plan-r2.md#L368-L378)), but the negative regression test ([./03-plan-r2.md](./03-plan-r2.md#L317-L319)) must prove that a router returning bare `PLAN_COMPLETE` text *does not* terminate the planner. The current source file [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L1-L100) contains the literal token in its docstring, comments, and call-2 stub response. After the migration the docstring and comments will be rewritten, but the test still has to feed the literal string into the router stub to prove the protocol is dead.

Both reviewer-suggested resolutions work. r3 picks the second — construct the token in tests without a contiguous literal — for three reasons:

1. **No special-case grep.** A scoped grep (`--exclude='*.test.ts'`) keeps working today but is one more rule operators must remember; any future test that genuinely needs to reference the legacy literal would silently slip past it.
2. **Cross-finding hygiene.** G04 and G11 will each need their own negative regression tests against legacy free-text protocols. A "tests construct dead tokens via concatenation" convention generalises cleanly and lets every finding share the same `grep -rn LEGACY_TOKEN src/ prompts/` post-condition without per-test exceptions.
3. **It is hermetic.** Reading `"PLAN_" + "COMPLETE"` in the test source proves at compile time that the literal contiguous string never appears anywhere in `src/`. The grep enforces the production property without any rule the reviewer has to verify on each change.

The negative test therefore builds the legacy token as `const LEGACY_TOKEN = "PLAN_" + "COMPLETE";` (or equivalent concatenation) and uses `LEGACY_TOKEN` in the stub router response and in any assertion. The docstring at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L1-L6) is rewritten to describe the new structural protocol (plan_done) and the regression target (ignoring the legacy text token) without spelling that token out; the inline comments at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L80-L92) are rewritten the same way. After the rewrite, `grep -rn PLAN_COMPLETE src/ prompts/` returns zero against the executable tree, including the test file.

## D. Other r2 claims that survive r3 unchanged

- The terminal-tool hook is a single protected method on `BaseAgent` with a `null` default — no generic framework. r3 only constrains the override.
- The `plan_done` return type stays `Promise<{ ok: true; recorded: boolean } | PlanError>` and both dispatch paths stay tested.
- `AgentContext.planService` is required, not optional; every construction site adds the field (TypeScript catches misses at the type-check step).
- The `PLAN_TOOLS` allow-list adds `"plan_done"`; `WORKER_EXCLUDED_TOOLS` gates workers transitively.
- Rollback is `git revert <sha>` with no mixed protocol mode.
- F14 message-non-duplication remains as a separate assertion in the same test file.

## E. Cross-links (revised)

- **G07** — compaction. With §B's ordering and §A's consume, the terminal `runLoop` return cannot be lost by summarisation: the structural `plan_done` tool_use is preserved as a `ToolRound` block, and `pendingCompletion` is the per-process audit trail.
- **G04** — manager final-response. The §B exclusivity rule and the §A consume pattern transfer directly; `manager_done` becomes the second concrete user of `detectTerminalToolCall` on a different agent.
- **F14** — nudge non-duplication. Re-asserted in the rewritten test alongside the new terminal-success and bare-legacy-text-rejection tests.
- **G11** — chat restart regex. Independent; r3 establishes the pattern (tagged completion + structural terminal hook + tests-via-concatenation) that G11 will follow.
