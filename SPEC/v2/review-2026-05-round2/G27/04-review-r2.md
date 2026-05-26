# G27 - Review r2

## Verdict

Approved. Round 2 resolves all four required changes from the round-1 review. The active-stage timestamp contract is now consistent across analysis, design, plan, and tests; the deterministic-clock requirement is explicit; the G28 inverted-order contingency no longer proposes a required `started_at`; and rollback is dependency-aware once G28 has landed.

## Verified Changes

1. **`plan_set_stages` timestamp preservation is consistent.** The analysis now defines `plan_set_stages` as a stage-set update rather than a timestamp reset, preserving existing `started_at` by stage id when the incoming stage omits it, letting an explicit caller-provided value win, and stamping the selected current stage only if it remains blank ([01-analysis-r2.md](01-analysis-r2.md#L110-L149)). The design mirrors that with `preserveStartedAt` plus `stampStarted` in the `plan_set_stages` path ([02-design-r2.md](02-design-r2.md#L52-L93)), and the plan implements the same sequence in step 4 ([03-plan-r2.md](03-plan-r2.md#L72-L86)). The tests now assert preservation of `stg-1.started_at`, stamping of newly current `stg-2`, and caller-supplied timestamp precedence ([02-design-r2.md](02-design-r2.md#L166-L179), [03-plan-r2.md](03-plan-r2.md#L141-L159)).

2. **Timestamp tests are deterministic while preserving the strict ordering assertion.** The design and plan both require Vitest fake timers and explicit `vi.setSystemTime(...)` advances between the start and completion writes ([02-design-r2.md](02-design-r2.md#L149-L153), [03-plan-r2.md](03-plan-r2.md#L104-L123)). The strict `completed_at > capturedStartedAt` assertion remains, but it is now backed by a controlled clock advance rather than wall-clock millisecond luck ([02-design-r2.md](02-design-r2.md#L184-L192), [03-plan-r2.md](03-plan-r2.md#L116-L123)).

3. **The G28 landing-order contingency is aligned.** The analysis calls out that G28's required placeholder is incompatible with queued stages and requires any G28-first emergency path to amend the placeholder to `started_at: z.string().optional()` before shipping ([01-analysis-r2.md](01-analysis-r2.md#L190-L219)). The plan repeats the same gate, keeps the default order as G27 -> G28 -> G29, and explicitly forbids shipping G27 on top of a required-`started_at` placeholder ([03-plan-r2.md](03-plan-r2.md#L280-L307)).

4. **Rollback is dependency-aware after G28.** The plan now splits rollback into Regime A (G27 deployed before G28, where a one-commit revert is allowed) and Regime B (G28 merged or deployed alongside G27, where a standalone G27 revert is forbidden) ([03-plan-r2.md](03-plan-r2.md#L201-L259)). The live deployment runbook carries that same boundary by requiring operators to check whether G28 is present before deployment or rollback and by rejecting an unconditional "revert G27" instruction in Regime B ([03-plan-r2.md](03-plan-r2.md#L331-L365)).

## Required Change Count

0

VERDICT: APPROVED