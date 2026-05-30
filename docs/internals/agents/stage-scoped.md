# Stage-scoped agents: Reviewer, Designer, Critic

[`src/agents/reviewer.ts`](https://github.com/salva/saivage/blob/main/src/agents/reviewer.ts)
· [`src/agents/designer.ts`](https://github.com/salva/saivage/blob/main/src/agents/designer.ts)
· [`src/agents/critic.ts`](https://github.com/salva/saivage/blob/main/src/agents/critic.ts)

These three agents are **stage-scoped**: their conversation persists for the
duration of a single stage. The Manager may dispatch them multiple times within
the stage (initial pass, post-correction, final re-pass); later calls continue
the same session so each turn builds on prior reasoning.

All three return a `TaskReport`. The schema is identical to Coder/Researcher
(see [workers](./workers#taskreport-schema)).

## Reviewer

**Purpose:** independent quality gate for stage work before the Manager
produces a `StageSummary`.

**Lifecycle:** stage-scoped — persists for the duration of one stage. The
Manager may dispatch it multiple times (initial review, post-correction
review, final re-review); later calls continue the same review session.

**Inputs:**

- Stage description, objectives, acceptance criteria
- Worker `TaskReport`s and work products (code, tests, docs, data artifacts)
- Relevant skills (auto-loaded)

**Outputs:**

- Review findings and reports under `.saivage/stages/`, `reviews/`, or
  `reports/`
- Task report with `status`, `checklist_results`, `issues_found`, and
  `summary`

**Behaviors:**

- Inspects worker outputs against acceptance criteria; flags gaps before the
  Manager closes the stage.
- Does not redo worker work; may run tiny verification commands.
- Does not modify implementation, research, or data artifacts.
- **Commits** review findings via the MCP git tool.

## Designer

**Purpose:** produce product, UX, interface, information-architecture, and
system-design artifacts that make ambiguous implementation work concrete
before coding starts.

**Lifecycle:** stage-scoped; dispatched by the Manager via `run_designer(task)`.

**Inputs:**

- A design `Task` with description, checklist, dependencies, and stage
  context.

**Outputs:**

- Task reports (`.saivage/stages/<stage-id>/reports/<task-id>.json`)
- Design artifacts written under `research/design/`, `docs/`, or the stage
  artifact directory named by the task.

**Behaviors:**

- Produces concrete, implementation-ready design briefs, flows, state
  inventories, accessibility notes, and architecture/design decisions; does
  **not** produce production source code.
- Inspects existing product, UI, docs, and code to fit the existing design
  system and constraints.
- Self-assesses every checklist item.
- **Commits** design artifacts via the MCP git tool when files are created or
  modified.

## Critic

**Purpose:** review the design documents produced by the Designer (and
design-adjacent docs from other roles) and write a standalone critique
document with actionable issues.

**Lifecycle:** stage-scoped; dispatched by the Manager via `run_critic(task)`.

**Inputs:**

- A critique `Task` whose description names the design artifacts under review,
  plus stage context.

**Outputs:**

- Task reports (`.saivage/stages/<stage-id>/reports/<task-id>.json`)
- A standalone **critique document** written at the project-relative path that
  best fits the artifact under review, typically
  `research/design/critiques/<artifact-id>.md`,
  `docs/critiques/<artifact-id>.md`, or
  `.saivage/stages/<stage-id>/critiques/<task-id>.md`.

**Behaviors:**

- Reads design briefs, specs, architecture docs, UX flows, and interface
  contracts; inspects referenced source/docs only to judge fit.
- Probes for hand-wavy goals, missing acceptance criteria, contradictions,
  undefined terms, hidden assumptions, undefined interfaces, ambiguity that
  blocks the Coder, and design that does not fit the existing codebase or
  product.
- Distinguishes blockers from improvements from nits in `issues_found[]`.
- Does **not** rewrite the design, write source code, produce data artifacts,
  or review code/tests/data (that is the Reviewer's job).
- **Commits** the critique document via the MCP git tool.
