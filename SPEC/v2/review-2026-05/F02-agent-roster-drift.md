# F02 — Agent roster drift between SPEC, schemas, dispatcher, and code

**Category**: documentation-mismatch
**Severity**: high
**Transversality**: architectural

**Status**: landed in working tree (pre-commit); see [src/agents/roster.ts](src/agents/roster.ts) and [src/agents/roster.test.ts](src/agents/roster.test.ts). Card retained for review-trail purposes.

## Summary

The set of agent roles described in `SPEC/v2` no longer matches what the code implements. The schemas, dispatcher, supervisor priority list, and `AgentRole` enum each draw a slightly different boundary, and none of them matches the documentation. A new contributor has to triangulate four sources to find the real roster.

## Evidence

- `TaskSchema.assigned_to` enumerates `["coder","researcher","data_agent","reviewer"]`: [src/types.ts](src/types.ts#L110-L116).
- `TaskReportSchema.agent` enumerates the same four: [src/types.ts](src/types.ts#L160-L165).
- `AgentStateSchema.agent_type` enumerates eight roles (adds planner, manager, inspector, chat — but excludes designer): [src/types.ts](src/types.ts#L292-L304).
- `DISPATCH_ROLE_MAP` exposes six dispatchable roles (no planner, no chat): [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L25-L32).
- Supervisor `ROLE_ABORT_PRIORITY` lists only five (omits chat, inspector, planner): [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L13-L19).
- Inline planner prompt enumerates Planner / Manager / Coder / Researcher / Inspector / Chat — no Data Agent, no Reviewer: [src/agents/planner.ts](src/agents/planner.ts#L21-L26).
- Inline manager prompt enumerates Coder / Researcher / Data Agent / Reviewer: [src/agents/manager.ts](src/agents/manager.ts#L24-L31).

## Why this matters

The roster is the single most foundational fact about a multi-agent system; having four authoritative-looking sources that disagree means every later inconsistency is harder to spot. The planner prompt notably omits Data Agent and Reviewer entirely, so the strategist's mental model of its own crew is incomplete.

##  Operator comment

The design drifted aways from the initial specification. Keep all the new agents event when thy are not defined in the spec. Also, the implementation behaviour should be considered the right one over the specification one (though, that should not preclude for fixing bugs/issues found in those agents/subsystems/flows/whatever!)

## Related

- F01 (designer orphan)
- F18 (planner prompt drift)
- F23 (supervisor priority is incomplete)
