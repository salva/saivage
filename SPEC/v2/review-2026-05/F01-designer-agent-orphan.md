# F01 — Designer agent is orphaned dead code

**Category**: dead-code
**Severity**: medium
**Transversality**: module

## Summary

`src/agents/designer.ts` defines a fully-formed `DesignerAgent` class with a ~250-line system prompt, normalisation helpers, and a `run()` method, but no part of the system can reach it: it is not in the public barrel, not in the role enum, not in the dispatcher tool map, and not in the runtime spawner.

## Evidence

- The file itself exists and is non-trivial: [src/agents/designer.ts](src/agents/designer.ts#L1-L40), [src/agents/designer.ts](src/agents/designer.ts#L140-L267).
- The barrel does not export it (the other seven agents are all listed): [src/index.ts](src/index.ts#L55-L65).
- The `AgentRole` enum has eight roles but `designer` is not among them: [src/agents/types.ts](src/agents/types.ts).
- The dispatcher does not register a `run_designer` tool: [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L16-L33).
- The schema enums in `TaskSchema.assigned_to` and `TaskReportSchema.agent` likewise do not include `designer`: [src/types.ts](src/types.ts#L110-L116), [src/types.ts](src/types.ts#L160-L165).

## Why this matters

A ~250-line module pretending to be an active agent role inflates the surface area readers must understand, gets imported into none of the test suites, and accumulates the same drift as the live agents (its `normalizeTask`/`parseTaskReport`/`buildFailureReport` duplicates are also out of date). Either wire it in or delete it.

## Operator note

Wire this agent in the system! Do not remove it!!!

## Related

- F09 (worker-agent duplication)
- F02 (agent roster drift)
