# F01 — Designer agent is orphaned dead code

**Category**: dead-code
**Severity**: medium
**Transversality**: module

## Summary

`src/agents/designer.ts` defines a fully-formed `DesignerAgent` class with a ~250-line system prompt, normalisation helpers, and a `run()` method, but no part of the system can reach it: it is not in the public barrel, not in the role enum, not in the dispatcher tool map, and not in the runtime spawner.

## Status

F09 deleted `src/agents/designer.ts` (the orphan), and F02 derived the role surface from `src/agents/roster.ts`. The remaining task for F01 is constructive: implement `class DesignerAgent extends WorkerAgent`, widen `ROSTER` to include `designer` (which regenerates `AgentRole`, `WorkerRole`, `DispatchableRole`, the dispatcher tool map, `TaskSchema.assigned_to`, `TaskReportSchema.agent`, `AgentStateSchema.agent_type`, the supervisor abort priority, the self-check schedule, and the planner-prompt roster summary), add the `run_designer` dispatcher tool wiring, and update the Manager prompt. The `[F01/APPROVED.md](F01/APPROVED.md)` Proposal C plan applies as written.

## Why this matters

A ~250-line module pretending to be an active agent role inflates the surface area readers must understand, gets imported into none of the test suites, and accumulates the same drift as the live agents (its `normalizeTask`/`parseTaskReport`/`buildFailureReport` duplicates are also out of date). Either wire it in or delete it.

## Operator note

Wire this agent in the system! Do not remove it!!!

## Related

- F09 (worker-agent duplication)
- F02 (agent roster drift)
