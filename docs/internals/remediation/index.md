# Saivage v2 Remediation Records

This section keeps the small set of remediation records that still document
current architecture decisions. Earlier working analysis, design-review packets,
and implementation plans were removed after the cleanup they guided was
implemented. Current subsystem behavior is documented in the main internals docs.

## Principles

- Keep role permissions simple. Tool access is a coarse affordance, not the main
  behavioral control system.
- Put behavioral expectations in prompts, role conventions, and typed artifact
  contracts.
- Let agents choose their tactics inside those conventions.
- Make the runtime an observer and contract validator before it is a controller.
- Prefer nudges, repair prompts, and retry loops over hard denial when the issue
  is behavioral drift.
- Use hard runtime refusal only for corruption, secrets, process safety,
  malformed state transitions, or operator/security boundaries.
- Remove compatibility scaffolding and stale transition code when it no longer
  serves the clean v2 architecture.

## Current Records

| Area | Record | Outcome |
| --- | --- | --- |
| Stage execution data | [Stage run data model](./stage-run-data-model.md) | `StageRunStore`, typed artifact tools, lifecycle events, and completion events are implemented. Compatibility files plus `.saivage/events.jsonl` remain the supported storage layout until a concrete migration need appears. |
| Architecture/data cleanup | [Architecture and data cleanup master plan](./v2-architecture-data-cleanup-master-plan.md) | Records the staged cleanup that simplified schemas, stage ownership, plan-history reads, worker dispatch, MCP runtime structure, bootstrap composition, config schema organization, and final legacy shims. |
| Event/history storage | [Event and history canonicalization](./event-history-canonicalization.md) | Keeps stage artifacts canonical, treats events as timeline/read-model evidence, and defers per-stage aggregate, SQLite, or event-sourcing migrations until there is a concrete trigger. |

## Current Authority

- [Architecture](../architecture.md)
- [Source tree](../source-tree.md)
- [Agents](../agents/)
- [Runtime details](../runtime/details.md)
- [MCP services](../mcp/services.md)
- [On-disk layout](../data/on-disk-layout.md)

## Success Criteria

- The runtime core can be explained without reading server bootstrap code.
- An agent turn can be tested with a stub model and deterministic tool outputs.
- Plan, task, report, knowledge, and runtime state each have one owning service
  or repository.
- Workers and managers produce typed artifacts through validated tools or
  validated on-disk files, while prompts still describe the expected behavior
  and conventions.
- The web/API layer reads through application services, not arbitrary raw files.
- Provider routing behavior is decomposed into independently testable policies.
- Legacy/stub/backward-compatible paths are deleted unless a current deployment
  genuinely requires them.
