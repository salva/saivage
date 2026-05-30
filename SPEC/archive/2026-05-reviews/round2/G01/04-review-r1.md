# G01 — Review of writer r1

## Analysis review

**Correctness.** The analysis matches the current source. Spot checks confirm the roster contract exists as `toolFilter` plus nullable `abortPriority` on [src/agents/roster.ts](src/agents/roster.ts#L25-L27), with non-abortable planner/chat/inspector values on [src/agents/roster.ts](src/agents/roster.ts#L46-L47), [src/agents/roster.ts](src/agents/roster.ts#L175-L176), and [src/agents/roster.ts](src/agents/roster.ts#L197-L198). The duplicate supervisor table is real at [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L12-L22), and `selectAbortTarget()` sorts every registered agent through that table without filtering null-priority roles at [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L154-L158). The analysis is also right that the current runtime test encodes the broken behavior by expecting inspector, chat, and planner to be cancelled after worker roles at [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L255-L281).

**Clean architecture.** The analysis identifies the actual root cause rather than only the local symptom: several consumers re-declare roster-derived facts. Its cross-checks are valid: dispatcher already derives `DISPATCH_ROLE_MAP` from roster at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L17-L22), but still hardcodes worker concurrency roles at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L265-L294); base agent filtering ignores `ROSTER.toolFilter` at [src/agents/base.ts](src/agents/base.ts#L628-L634) and falls back to a partial role map at [src/agents/base.ts](src/agents/base.ts#L1104-L1123); manager validation hardcodes dispatch tool names at [src/agents/manager.ts](src/agents/manager.ts#L110-L115).

**No backward compat / dead-code removal.** The analysis correctly frames deletion, not aliasing, as the required remediation at [SPEC/v2/review-2026-05-round2/G01/01-analysis-r1.md](SPEC/v2/review-2026-05-round2/G01/01-analysis-r1.md#L114-L123). No migration shim or transitional branch is recommended.

**Completeness and cross-finding coordination.** The analysis explicitly connects G01 to G02/G03/G04 at [SPEC/v2/review-2026-05-round2/G01/01-analysis-r1.md](SPEC/v2/review-2026-05-round2/G01/01-analysis-r1.md#L56-L76), which is useful for the metaplan. The only thing the analysis leaves as an open decision is whether G01 should subsume the siblings; the design resolves that.

**Testability.** The analysis names the existing tests that need rewriting and identifies the missing null-priority case. That is sufficient as analysis, because the detailed test surface is properly deferred to design/plan.

## Design review

**Clean architecture.** Design B is the right direction. The new roster accessors at [SPEC/v2/review-2026-05-round2/G01/02-design-r1.md](SPEC/v2/review-2026-05-round2/G01/02-design-r1.md#L65-L101) are thin wrappers over fields that already exist on `ROSTER`, and the consumer rewrites target the actual duplicate tables. This is a genuine level-up design, not abstraction for its own sake.

**No over-engineering.** The proposed API surface is small: four pure helpers plus one internal tool-filter module. `isConcurrencyLimitedDispatch()` is just a policy wrapper over `worker`, but it pulls its weight because it prevents every dispatcher caller from re-learning which dispatchable roles are workers. No new roster field is added.

**Correctness and drift elimination.** G01 itself is fixed by deriving abort priority and filtering null priorities before sorting. G02/G04 are also directly fixed through roster-derived dispatch helpers. G03 is mostly fixed, but the proposed `applyToolFilter()` switch at [SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md#L101-L132) should be made explicitly exhaustive. `ToolFilterKind` is an exported union at [src/agents/roster.ts](src/agents/roster.ts#L13), `assertExhaustive()` already exists at [src/agents/roster.ts](src/agents/roster.ts#L259-L261), and [tsconfig.json](tsconfig.json#L2-L16) does not set `noImplicitReturns`; without an exhaustive record or `assertExhaustive(kind)`, a future filter kind can reintroduce the same drift class.

**No backward compat.** The design is compliant. It states that no existing export is removed or renamed at [SPEC/v2/review-2026-05-round2/G01/02-design-r1.md](SPEC/v2/review-2026-05-round2/G01/02-design-r1.md#L180-L182), but it also deletes the duplicate private tables and hardcoded lists at [SPEC/v2/review-2026-05-round2/G01/02-design-r1.md](SPEC/v2/review-2026-05-round2/G01/02-design-r1.md#L185-L202). That is not backward-compat preservation; it is a clean internal API addition plus dead-code removal.

**Cross-finding coordination.** The design says unambiguously that G02, G03, and G04 are subsumed at [SPEC/v2/review-2026-05-round2/G01/02-design-r1.md](SPEC/v2/review-2026-05-round2/G01/02-design-r1.md#L241-L243), and the listed consumer rewrites map to the sibling issue evidence. That is clear enough for the metaplan to collapse those findings into G01.

**Project rule.** The design does not propose docstrings/comments in untouched files. The new module is touched code, so any necessary local explanatory comments would be allowed, but none are needed beyond existing naming.

## Plan review

**Completeness.** The implementation steps name the main production files and test files, but the rollback section says the change is contained to seven files while listing nine paths at [SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md#L291-L298). Tighten that count and the file list so the metaplan has an exact blast radius.

**Validation sufficiency.** The validation block has a concrete problem: the second targeted Vitest command at [SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md#L258-L259) names two targeted test paths that do not exist in this checkout. Either create the missing targeted tests and include them in the file list, or replace the command with existing test files plus the new tests. Do not leave a validation command whose behavior depends on Vitest's path-filter quirks.

**Testability.** Accessor tests in [src/agents/roster.test.ts](src/agents/roster.test.ts#L80-L101) are easy to extend, and the plan does add roster and tool-filter tests at [SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md#L222-L249). That is good, but not complete for the subsumed findings: G02 needs a black-box dispatcher test proving duplicate `run_designer` dispatches are rejected through `enforceDispatchLimits()`, and G03 needs at least one integration-style assertion that role tool schemas consume `getToolFilter()` rather than only testing `applyToolFilter()` in isolation.

**Dead-code removal.** The plan explicitly deletes the old supervisor table, dispatcher disjunction, base-agent tool-filter map, and manager hardcoded list at [SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md#L35-L41), [SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md#L66-L74), [SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md#L158-L163), and [SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md#L166-L181). The sweep commands at [SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md#L266-L279) are a good backstop.

**Rollback / running daemons.** The rollback section acknowledges `saivage-v3` but incorrectly stops there: [SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md#L300-L308) says the GetRich v1 and GetRich v2 containers need no action, and it omits the `diedrico` v2 harness entirely. Because this source tree can be bind-mounted into running v2 harnesses, the plan must explicitly say which daemons are affected, how to verify their bind mounts/service commands, and which restart/health probes to run after rollback. Also remove the `git reset --hard` rollback suggestion from [SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md#L291-L299) unless the operator has explicitly requested destructive local cleanup.

**No backward compat / project rule.** The plan has no migration shims, deprecated aliases, or transitional branches. It also does not add docstrings/comments to untouched files; step 6 explicitly leaves the existing manager header alone at [SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G01/03-plan-r1.md#L183-L187).

## Required changes (if any)

1. Make `applyToolFilter()` exhaustive over `ToolFilterKind`, either with a typed `Record<ToolFilterKind, ...>` or an `assertExhaustive(kind)` branch, so G03 cannot drift again when a filter kind is added.
2. Fix the validation/test plan: remove or create the nonexistent targeted test paths named in the Vitest command, correct the file-count/blast-radius list, and add consumer-level tests for duplicate designer dispatch rejection plus role tool-schema filtering, not only pure accessor tests.
3. Revise rollback and deployment validation to cover every potentially running v2 harness, especially `diedrico` and the GetRich v1 `saivage` deployment; include bind-mount/service verification, restart/health probes where needed, and remove the unapproved `git reset --hard` fallback.
4. Update the cross-finding metaplan note after the above changes so G02/G03/G04 are collapsed only with the added consumer tests and daemon rollback coverage attached to G01.

VERDICT: CHANGES_REQUESTED