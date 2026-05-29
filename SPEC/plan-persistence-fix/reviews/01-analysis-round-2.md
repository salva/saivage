# Round 2 Review — 01-analysis.md

## RUBRIC CHECK
- R1: PASS — Symptom includes the user-facing wording and concrete timestamps `15:06:42` and `15:08:58`.
- R2: FAIL — Most evidence is now concrete, but several source line citations are stale or inaccurate, especially recovery/debug-route citations.
- R3: PASS — Reproduction conditions are explicitly enumerated and tied to planner dispatch, manager execution, and plan-service validation behavior.
- R4: PASS — The drift path names `createChildSpawner`, `case "manager"`, worker dispatch normalization, and `normalizeStage`, with `normalizeStage` cited as [saivage/src/agents/manager.ts](saivage/src/agents/manager.ts#L118-L129).
- R5: PASS — Blast radius lists more than three consumers with cited paths, including `/api/plan`, `/api/state`, debug endpoints, timeline, and planner recovery prompts.
- R6: PASS — "What is NOT broken" identifies multiple working paths: stage artifacts, runtime tracker state, worker execution, Plan MCP behavior, endpoint behavior, and stage-scoped caching.
- R7: PASS — No remediation design or implementation steps; mentions of absent guards/tool calls are analytical, not prescriptive.
- R8: PASS — Open questions explicitly state what could not be determined from the available inputs.
- R9: FAIL — Several file references remain plain backticked names/paths instead of workspace-relative markdown links.
- R10: PASS — The journal-grep claim includes the full alternation pattern and the result count, and covers the seven plan-writer tools plus the three named service error codes.

## REQUIRED CHANGES
1. Correct stale line citations. Examples: continuous-improvement recovery branch is at [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L673-L681), not `#L780-L808`; `queuePlannerDirective` at [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L611-L613), not `#L639-L641`; debug state at [saivage/src/server/server.ts](saivage/src/server/server.ts#L493-L512), not `#L466-L489`. Re-verify ALL line citations against current file content.
2. Fix remaining R9 citation-format violations. Plain backticked file references remain at lines ~23, 54-55, 142, 153, 197-202, 220-237, 275-276, 318-319, 346-349.
3. Either convert the raw `/opt/saivage` deployment path reference (~L95-97) into a clearly non-workspace runtime datum, or remove it if it cannot be cited under the document's citation rules.

## SUGGESTED IMPROVEMENTS (non-blocking)
- Current runtime.json now reports stage-364, not stage-362. Word runtime evidence as point-in-time snapshot.
- Current saivage.json has `runtime.continuousImprovement: false`; if incident depended on earlier config, cite as runtime-loaded state.

## VERDICT
CHANGES_REQUESTED
