# Phase B — Design Review (round 3)

Status: REVIEW
Reviewer: GPT-5.5
Verdict: ACCEPT
Date: 2026-05-23

## Verdict

ACCEPT: the round-3 concurrency model is now implementable and coherent enough for Phase C, with only non-blocking textual residue remaining.

## Round-2 dispositions audit

| Round-2 finding | Audit | Evidence |
|---|---|---|
| Wrong-fix 1: Blocking 4 — audit/concurrency primitives still relied on TOCTOU mtime/CAS | CONFIRMED | §C.3 now says `writeRecordAtomic` has no mtime/CAS check and is serialized by the per-record mutex; `appendJsonlAtomic` uses `O_APPEND` and caps audit entries; transaction order is explicit. Evidence: 01-DESIGN.md:303-345. |
| Wrong-fix 2: Non-blocking 6 — sweeper expiry depended on the flawed write primitive | CONFIRMED | §G.2 routes expiry through `writeRecordAtomic`, takes the same per-record mutex, re-reads under lock, and skips if status changed. Evidence: 01-DESIGN.md:714-728. |
| Wrong-fix 3: Architectural 1 — store boundary existed but lacked a correct concurrency primitive | CONFIRMED | §C.3 centralizes store behavior in `src/knowledge/store.ts` with `writeRecordAtomic`, `appendJsonlAtomic`, `rebuildIndex`, and the module-scoped lock map. Evidence: 01-DESIGN.md:298-345. |
| Wrong-fix 4: Spot-check FR-29 — same-record writes could silently overwrite | CONFIRMED | §C.3 defines a per-record async mutex and ordered same-id updates; §I and §L pin store/concurrency tests and FR-29 coverage. Evidence: 01-DESIGN.md:326-345, 01-DESIGN.md:807-813, 01-DESIGN.md:1012. |
| New blocker: race-free store plus `supersede_*` atomic two-record mutation | CONFIRMED | §C.3 now defines deterministic two-key lock acquisition, old-record re-read, rollback on step-3 failure by unlinking the NEW record/body, audit/index behavior, and loader repair for reachable crash states. Evidence: 01-DESIGN.md:349-367. |
| NB1: oversized survivor behavior internally inconsistent | WRONG-FIX | §D.2 and §E.1 now define the right behavior: write-time refusal and load-time quarantine with `oversized_survivors` ids. However §I still says oversized survivors “appear” with a warning header, contradicting quarantine. Evidence: 01-DESIGN.md:475-479, 01-DESIGN.md:616, 01-DESIGN.md:821-822. Non-blocking because the normative behavior is clear in §D.2/§E.1. |
| NB2: worker scope wording contradicted itself | CONFIRMED | §A.1, §C.1, and §F all say Coder/Researcher may create/update only stage-scoped memories, with promotion reserved to Planner/Manager/Inspector. Evidence: 01-DESIGN.md:43, 01-DESIGN.md:264-268, 01-DESIGN.md:682-690. |
| NB3: FR-24 matrix cited nonexistent J.3 step 9 | CONFIRMED | §L now points FR-24 and FR-31a to J.3 step 8, matching the eight-step build order. Evidence: 01-DESIGN.md:1007, 01-DESIGN.md:1014. |

## Concurrency spot-check

| Item | Result | Evidence |
|---|---|---|
| `expectedMtimeMs` / `STALE_WRITE` / mtime checks absent by terminal grep | FAIL (textual only) | Terminal `rg -n "expectedMtimeMs|STALE_WRITE|mtime" SPEC/v2/skills-memory/01-DESIGN.md` still hits 01-DESIGN.md:303, 01-DESIGN.md:345, 01-DESIGN.md:396, 01-DESIGN.md:1052, 01-DESIGN.md:1073, and 01-DESIGN.md:1086. The active design uses these only in negated or historical prose; there is no remaining normative mtime/CAS mechanism. |
| Single-writer invariant stated with backing code citation | PASS | §C.3 states one Node process per project, in-process child agents, and MCP tool execution in the same event loop. The cited code backs the in-process claim: `Dispatcher.childSpawner` is a callback field/registration and is invoked directly at src/runtime/dispatcher.ts:64-74 and src/runtime/dispatcher.ts:239; BaseAgent registers it at src/agents/base.ts:177-178; `McpRuntime.callTool` awaits in-process service handlers at src/mcp/runtime.ts:173-190. |
| `supersede_*` rollback and loader-repair rules | PASS | §C.3 has explicit step-3 rollback: unlink NEW record + body, append rejected audit, surface error; it also defines loader repair when NEW points to OLD but OLD lacks `superseded_by`, and re-emits missing supersede audit lines. Evidence: 01-DESIGN.md:349-367. |
| 2048 B audit-entry cap realistic/platform-scoped | PASS | §C.3 says `PIPE_BUF` is 4096 B on Linux and hard-caps single audit entries at 2048 B, with truncation of `reason`; this is safely under the stated Linux bound. Evidence: 01-DESIGN.md:306-310. |

## New regressions

No new blocking regressions.

- **Low severity:** the strict old-concurrency grep still fails because negated/historical prose mentions `mtime`, `expectedMtimeMs`, and `STALE_WRITE`. This should be cleaned up, but it does not leave an implementable stale-write design path.
- **Low severity:** §I's loader-test bullet still contradicts §D.2/§E.1 on corrupted oversized survivors; Phase C should follow §D.2/§E.1 quarantine semantics.

Cross-checks: §G.2, §I store/concurrency tests, and §L FR-29 now align with §C.3. §K explicitly records cross-process concurrency as a non-goal and names `flock(2)` as the migration path if Saivage ever grows multi-process workers (01-DESIGN.md:968-975).

## Sign-off

ACCEPT. Phase C can begin. The remaining cleanup items are non-blocking documentation residue; a competent Phase C implementer can follow §C.3 and §D.2/§E.1 without re-asking the design author.