# F23 — Supervisor abort priority list excludes Chat, Inspector, and Planner

**Category**: half-implemented
**Severity**: medium
**Transversality**: module

## Summary

`ROLE_ABORT_PRIORITY` is the supervisor's only mechanism for picking who to cancel when the LLM verdict says "stuck". It lists only `["reviewer", "data_agent", "coder", "researcher", "manager"]`. If a chat session, an inspector run, or the planner itself is the stuck party, the supervisor logs "no lower-level agent is running" and does nothing.

## Evidence

- The constant: [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L13-L19).
- The check at the abort site: [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L91-L108).
- All registered agent roles BaseAgent can run as: [src/agents/types.ts](src/agents/types.ts).

## Why this matters

The Inspector is a one-shot deep-analysis run that can chew through context for a long time; if it stalls (e.g. an LLM call hanging), the supervisor cannot intervene. The Planner is even worse — it's the long-lived strategist; if it stalls the entire system stops, but the supervisor refuses to cancel it. The current behaviour is "supervisor is a safety net for workers only" which is much less than the prompt advertises.

## Related

- F05 (supervisor regex undermines verdict)
- F02 (roster drift)
