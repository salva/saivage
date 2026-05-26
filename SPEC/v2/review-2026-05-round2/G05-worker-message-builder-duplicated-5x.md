# G05 — Worker initial-message builders duplicated across five agent files

**Subsystem:** src/agents/
**Category:** duplication / refactor
**Severity:** medium
**Transversality:** module-level pattern (5 files)

## Summary

Round-1 F25 extracted `WorkerAgent` as a shared base for `coder/researcher/designer/data_agent/reviewer` and pulled `normalizeTask` / `parseTaskReport` / `buildFailureReport` into [src/agents/task-report.ts](src/agents/task-report.ts). The matching "build the initial user message for this worker" step was *not* extracted: each of the five files now has a near-identical `buildXxxMessage(ctx, input)` function that differs only in the leading heading line and one or two lines in the Instructions block. This is duplication-by-template, easy to miss in review, and the kind of code that drifts (and has already drifted — see §Evidence).

## Evidence

The five message builders:

- [src/agents/coder.ts](src/agents/coder.ts#L48-L73) — `buildCoderMessage`
- [src/agents/researcher.ts](src/agents/researcher.ts#L50-L75) — `buildResearcherMessage`
- [src/agents/designer.ts](src/agents/designer.ts#L49-L74) — `buildDesignerMessage`
- [src/agents/data-agent.ts](src/agents/data-agent.ts#L48-L71) — `buildDataAgentMessage`
- [src/agents/reviewer.ts](src/agents/reviewer.ts#L65-L96) — `buildReviewerMessage` (variant: takes `reviewNumber`)

The common skeleton, line-for-line: checklist render → `handoffBlock = await buildHandoffContext(...)` → `## <heading>` → `**Task ID:**` / `**Stage ID:**` / `**Type:**` / `**Attempt:**` → `### Description` → optional `### Checklist` → `### Instructions` with `Write the report to: .saivage/stages/${stageId}/reports/${task.id}.json` and `Commit using MCP git with message prefix: [${task.id}]`.

Drift evidence (real, not hypothetical):

- Coder / Researcher / Data-Agent / Reviewer say `Commit using MCP git with message prefix: [...]` unconditionally.
- Designer says `Commit using MCP git with message prefix: [...] if you modify files.` — extra conditional clause.
- Reviewer says `... if you create review files.` — third variant.
- Reviewer is the only file that calls `buildHandoffContext(ctx, { stageId, includeTasks: true })` *and* renders a follow-up review marker; the others are simpler.
- Data-Agent's Instructions block adds three role-specific lines (`Write downloaded artifacts to ...`, `Write provenance notes ...`, `Use retries, fallback ...`). The other four have no role-specific lines.

So today: the body has 4 different "commit prefix" sentences for what should be one rule; only one role injects role-specific guidance into the message body; all five repeat the surrounding boilerplate.

The factory wrappers `static async create(...)` are also near-identical: each calls `buildXxxMessage`, then `buildEagerBlock`, then constructs `new XxxAgent(...)` — five copies of the same 6-line idiom.

## Why this matters

- Changing the worker-message contract (e.g. adding a `**Trace ID:**` line, switching commit prefix, or refining the checklist render) requires touching five files, with no compile-time link to ensure all five stayed consistent. The current commit-prefix wording divergence proves the drift already happened silently.
- New worker roles (this round already introduced `designer`; the next role will repeat the pattern) need to copy ~75 lines of boilerplate per file.
- The duplication obscures the *interesting* per-role content (designer has none today; data-agent has three lines). A shared builder with a tiny per-role override would surface the actual contract.

## Rough remediation direction

Refactor into `WorkerAgent`. Add a single `buildWorkerInitialMessage` (and matching `static async createWorker(...)` factory) to [src/agents/worker.ts](src/agents/worker.ts), parameterised on:

```ts
interface WorkerMessageSpec {
  role: WorkerRole;
  heading: string;                       // "Task" / "Research Task" / "Design Task" / ...
  commitClause: string;                  // unified — pick one wording, kill the three variants
  extraInstructionLines?: string[];      // data-agent's three lines go here
  includeTasksInHandoff?: boolean;       // reviewer-only
  reviewNumber?: number;                 // reviewer-only follow-up marker
}
```

Then each of the five `*.ts` worker files becomes ~25 lines: a class declaration, a `static create` that calls `WorkerAgent.createWorker(ctx, input, { role: "coder", heading: "Task Assignment", ... })`, and nothing else. No more `buildXxxMessage`, no more duplicated factory boilerplate, no more commit-clause drift.

Cross-check the result with a snapshot test that compares the rendered initial message for each role against a golden file — once. Drift then becomes a failing test rather than a manually-noticed code review finding.

## Cross-links

- Continuation / completion of round-1 F25 (which extracted task-report helpers but stopped short of the message builder).
- Same theme as G06–G08: round-1 extracted some shared infrastructure but left adjacent duplication in place.
