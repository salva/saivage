# Saivage v2 Architecture Improvement Program

This packet records the target architecture and implementation plan for cleaning
up Saivage v2 after the June 2026 architecture review.

The guiding product idea is agent autonomy. Saivage agents should decide what to
do from their role prompts, conventions, evidence, and local context. The
runtime should not overfit the workflow by forcing every step from outside. The
runtime should instead provide a small set of reliable boundaries, observe the
agent's behavior, validate produced artifacts, and nudge the agent when it drifts
from its stated contract.

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

## Design Documents

| Order | Area | Design Doc | Outcome |
| --- | --- | --- | --- |
| 1 | Execution | [Implementation plan](./architecture-implementation-plan.md) | Revised phase order: hard structural simplification first, behavior changes after cleaner seams exist. |
| 2 | Review | [Design review critique](./design-review-critique.md) | Inconsistencies, overlooks, and suggested revisions to the design packet. |
| 3 | Agent session structure | [Agent session decomposition](./agent-session-decomposition.md) | Break `BaseAgent` into focused conversation, retry, and compaction components without over-extracting trivial views. |
| 4 | Runtime structure | [Runtime kernel split](./runtime-kernel-split.md) | Separate the truly complex runtime pieces, especially agent construction and Planner recovery. |
| 5 | MCP built-ins | [MCP built-ins modularization](./mcp-builtins-modularization.md) | Split the 2000-line built-ins module into injected service modules with explicit project/security context. |
| 6 | Agent autonomy and compliance | [Agent autonomy, conventions, and nudges](./agent-autonomy-conventions.md) | Preserve broad agent discretion while evolving existing repair hooks into deterministic drift nudges. |
| 7 | Artifact contracts | [Typed artifact submission](./typed-artifact-submission.md) | Replace final freeform JSON parsing with validated artifacts or terminal submission tools. |
| 8 | Persistence ownership | [Persistence ownership](./persistence-ownership.md) | Centralize project file I/O and stop mixing cached services with direct raw file reads. |
| 9 | Server/API structure | [Server API modularization](./server-api-modularization.md) | Split HTTP routes from reads/commands, redaction, static assets, file browsing, and chat lifecycle. |
| 10 | Provider routing | [Provider router decomposition](./provider-router-decomposition.md) | Decompose routing policies later, only where focused tests need it. |
| 11 | Legacy cleanup | [Legacy and transition cleanup](./legacy-transition-cleanup.md) | Remove v1/backward-compatible/stub scaffolding where clean v2 no longer needs it. |
| 12 | Compatibility debt removal | [Compatibility debt removal plan](./compatibility-debt-removal-plan.md) | Concrete assessment and removal plan for remaining compatibility bridges, temporary fallbacks, and dead code candidates. |
| 13 | Post-simplification cleanup | [Architecture cleanup plan](./v2-architecture-cleanup-plan.md) | Implemented cleanup after commit `9705346`: lifecycle/orchestration seams, provider routing, tool-schema/RAG/persistence unification, and final route/read-model narrowing. |
| 14 | Runtime lifecycle | [Runtime lifecycle and orchestration](./runtime-lifecycle-and-orchestration.md) | Design for one lifecycle owner, one agent orchestrator, narrow runtime facades, and generic `BaseAgent` boundaries. |
| 15 | Provider route ownership | [Provider routing unification](./provider-routing-unification.md) | Design for canonical provider/account route objects and a thinner `ModelRouter` facade. |
| 16 | Tool and persistence contracts | [Tool schema and persistence unification](./tool-schema-and-persistence-unification.md) | Design for single-source Plan/RAG tool definitions, prompt fragments, RAG provider config ownership, shared atomic JSON writes, and SQLite metadata descriptors. |
| 17 | Stage execution data model | [Stage run data model](./stage-run-data-model.md) | Design for making stage execution a first-class aggregate, adding `StageRunStore`, typed artifact submission tools, lifecycle events, and eventually deriving history from stage runs. |

## Relationship To Existing Remediation Notes

Earlier remediation notes in this directory focused on specific correctness
issues such as RAG config typing, dispatcher semantics, local API posture, MCP
lifecycle, and abort/restart behavior. Those notes remain useful for local
history, but this packet supersedes any recommendation to make role behavior
primarily runtime-enforced.

The new target is:

- Runtime-enforced state integrity.
- Prompt- and convention-led role behavior.
- Runtime-observed compliance with nudges and evidence checks.
- Minimal compatibility obligations.

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
