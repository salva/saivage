# Phase A — Functional Analysis Review (round 2)

Status: REVIEW
Reviewer: GPT-5.5
Verdict: REVISE
Date: 2026-05-23

## Verdict

REVISE: the round-2 body is much closer and most fixes are correct, but the document still contains a blocking runtime-access contradiction in the gap matrix / round log / FR-31(e) that repeats the round-1 access-model problem.

## Round-1 Dispositions Audit

| Issue | Claimed disposition | Audit result | Evidence |
|---|---:|---:|---|
| BLOCK-1: spec-vs-runtime confusion | ACCEPT-FIX | WRONG-FIX | Main body is corrected in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L144-L157) and [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L556-L563): all roles can call `list_skills` / `read_skill`. But the gap matrix still says on-demand pull is `partial (Coder only)` in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1211), and the round log claims §2.8 was corrected to `only Coder has the on-demand skill MCP today` in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1262-L1266). Source confirms broad read access: [src/agents/base.ts](../../../src/agents/base.ts#L970-L1011). |
| BLOCK-2: `update_skill` cannot fix index | ACCEPT-FIX | CONFIRMED | [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L267-L284) now states `update_skill` writes only markdown and cannot refresh triggers, `target_agents`, `updated_at`, or reason; FR-31(c) pins the metadata/audit regression in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L906-L910). Source matches [src/mcp/builtins.ts](../../../src/mcp/builtins.ts#L1057-L1110). |
| BLOCK-3: atomic writes claimed but not used | ACCEPT-FIX | CONFIRMED | Current skill writes are moved to a write-integrity gap in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L354-L368), and §3 item 11 correctly treats `writeDoc` as a Phase B target, not a current skill property, in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L661-L668). FR-28 is testable in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L864-L870). |
| BLOCK-4: memory/index catalog state | ACCEPT-FIX | WRONG-FIX | The body correctly says memory/index are registered `available: false`, hidden from `getAllTools()`, and rejected by `callTool()` in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L301-L315). But the round log says the catalog hides them `when the underlying store is empty` in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1275-L1278), and FR-31(e) says `memory tools are reachable` today in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L911-L916). Source says unavailable services are omitted/rejected: [src/mcp/runtime.ts](../../../src/mcp/runtime.ts#L180-L184), [src/mcp/runtime.ts](../../../src/mcp/runtime.ts#L217-L222), [src/mcp/builtins.ts](../../../src/mcp/builtins.ts#L1166-L1168). |
| BLOCK-5: home-file option violates ground rules | ACCEPT-FIX (option rejected) | CONFIRMED | §5.4 Option B is explicitly rejected as non-compliant with the no-global-state ground rule in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L992-L999), and user-wide/cross-project memory stays out of scope in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1162-L1166). |
| BLOCK-6: FR-11 / FR-16 / FR-22 not testable | ACCEPT-FIX | CONFIRMED | FR-11 now requires runtime-enforced budget behavior with a concrete test in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L743-L750); FR-16 names an explicit compaction-time write opportunity in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L775-L781); FR-22 is scoped to Chat with web UI deferred in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L814-L821). |
| BLOCK-7: built-in path source vs bundle | ACCEPT-FIX | CONFIRMED | §1.4 now distinguishes source-tree and bundled `dist/cli.js` failure modes in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L220-L235), and FR-24 / FR-31(a) require source-run and production-bundle coverage in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L834-L842) and [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L898-L902). |
| BLOCK-8: `read_skill` ignores `entry.file` | ACCEPT-FIX | CONFIRMED | §1.5.6 documents the `read_skill` / loader path mismatch and the double-`skills/` spec example in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L317-L331); FR-31(d) pins a non-default file-path read regression in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L910-L912). |
| NB-1: actual runtime access matrix missing | ACCEPT-FIX | NOT-APPLIED | The document now has a skill read/write table in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L144-L157), plus memory/index and filesystem prose in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L301-L315) and [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L373-L376). It does not contain the claimed full matrix across skill-read, skill-write, memory-read, memory-write, and filesystem-write; this omission is part of why stale `Coder only` text survived. |
| NB-2: cross-agent visibility undefined | ACCEPT-FIX | CONFIRMED | §5.10 directly asks who can discover/search/read another role's records and gives access-table, hard-ACL, and Chat/Inspector-privileged options in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1068-L1089). |
| NB-3: notes vs memory boundary | ACCEPT-FIX | CONFIRMED | §1.5.8 distinguishes `NoteManager` from memory in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L342-L348), §3 item 10 treats it as a reusable pattern in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L653-L659), and OOS-10 keeps the two channels distinct in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1192-L1195). |
| NB-4: relation to inspections | ACCEPT-FIX | CONFIRMED | §5.11 reconstructs the core promotion/relationship question and gives three viable paths in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1091-L1113). It does not explicitly mention stale inspection review or `expires_at`; I list that as non-blocking below because the main Phase B decision is now present. |
| NB-5: compaction sufficiency | ACCEPT-FIX | CONFIRMED | §5.12 directly compares memory against `plan.json` embedded history and the compaction summary, with options and a boundary-pinning regression test in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1115-L1142). |
| NB-6: concurrent writes / index races | ACCEPT-FIX | CONFIRMED | FR-28 and FR-29 require atomic validation and conflict handling in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L864-L881), and FR-31(g) pins the race regression in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L921-L925). |
| NB-7: secrets handling | ACCEPT-FIX | CONFIRMED | FR-27 requires write refusal and retrieval redaction/refusal for secret-shaped content in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L855-L861), and FR-31(f) pins regression coverage in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L916-L920). |
| NB-8: deletion / archival ergonomics | ACCEPT-FIX | CONFIRMED | FR-30 adds explicit `archive_record` and `delete_record` behavior, plus archived-record retrieval semantics, in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L883-L890). |

Confirmed-as-fixed: 13. Not-applied: 1. Wrong-fix: 2.

## New Issues Introduced By Round 2

### Blocking

1. **Runtime access / availability contradictions remain in summary and tests.** The fixed body says every role can call `list_skills` / `read_skill`, while §7 and §9 still say or imply `Coder only`; FR-31(e) also says memory tools are reachable today even though memory/index are hidden and unavailable. This is not a style nit: it is the same factual substrate that blocked round 1, now localized to summary/test/round-log areas.

### Non-blocking

1. **Stale OOS reference.** §2.6 cites `OOS-11`, but §6 defines only OOS-1 through OOS-10. Evidence: [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L522) and [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1151-L1195).
2. **§5.11 is missing two inspection-adjacent words from the original intent.** The reconstruction covers promotion paths, but it does not explicitly mention inspection `expires_at` or stale report review. This is not blocking because FR-19 covers stale record enumeration and §5.11 now contains the main Phase B decision.

## Reconstruction Audit (§§5.10-5.12)

NB-2 asked for cross-agent visibility rules: who can discover/search/read records, whether one agent can see another agent's stage/session records, and how Planner/Manager/Chat visibility differs. §5.10 matches that intent: it asks the exact discover/search/read question, includes Coder/Researcher/Chat/Inspector examples, and offers three access models.

NB-4 asked for memory's relationship to inspections, including lifecycle, promotion, stale report review, `expires_at`, and whether findings become memory or remain reports. §5.11 matches the core promotion/relationship intent with reference, in-place promotion, and Planner-mediated options. It is slightly narrower than the original prompt because stale report review and `expires_at` are not named; I do not consider that a blocker.

NB-5 asked whether compaction plus `plan.json` embedded history is already sufficient, and what memory adds beyond those existing recovery channels. §5.12 matches this intent cleanly: it compares history-only, memory-only, and dual-read options and requires a regression test to pin the boundary.

## Remaining Blockers

1. Remove the residual `Coder only` access statements from the gap matrix and round log, or rewrite them to distinguish spec intent from runtime truth.
2. Fix FR-31(e) so it does not claim memory tools are reachable today. The test should separately cover unauthorized skill writes (`create_skill` / `update_skill` exposed to Manager/Designer/Chat today) and unavailable memory/index services being omitted/rejected.
3. Add or update the promised runtime access matrix so the document has one source of truth for skill read/write, memory/index availability, and filesystem write by role.

## Sign-off Conditions

Because the verdict is REVISE, must-fix items before ACCEPT are:

1. Correct §7 rows that still say `Coder only` for current skill behavior.
2. Correct §9 BLOCK-1 / BLOCK-4 round-log rationales so they describe the body's actual fixes.
3. Correct FR-31(e)'s current-state sentence about memory tools and unauthorized skill tools.
4. Either add the full runtime access matrix promised by NB-1, or revise the round log to stop claiming that matrix exists.
