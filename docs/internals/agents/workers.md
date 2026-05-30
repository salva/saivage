# Coder, Researcher & Data Agent

[`src/agents/coder.ts`](https://github.com/salva/saivage/blob/main/src/agents/coder.ts)
· [`src/agents/researcher.ts`](https://github.com/salva/saivage/blob/main/src/agents/researcher.ts)
· [`src/agents/data-agent.ts`](https://github.com/salva/saivage/blob/main/src/agents/data-agent.ts)

The Coder, Researcher, and Data Agent are **one-shot worker agents**. The
Manager spawns one (sometimes two or three of distinct roles in parallel) per
task, and they terminate as soon as they return their `TaskReport`.

## Shared properties

- Same `WorkerInput` shape: `{ task, stageContext }`.
- Same return type `TaskReport`.
- Same tool catalog: filesystem, shell, git, web (when available), memory,
  index. The three roles differ in their **system prompts** and
  **conventions**, not in their permissions.

## Coder

**Purpose:** write code, run commands, execute tasks, document the work.

**Territory:** project source code.

**Inputs:**

- Task description with checklist (from Manager)
- Relevant skills (auto-loaded based on task context)

**Outputs:**

- Task report (`stages/<stage-id>/reports/<task-id>.json`)

**Behaviors:**

- Reads relevant files, plans the edit, writes code, runs tests, commits with
  a message that includes the task id, then writes the `TaskReport`.
- Can read project files, documentation, and external resources (web, docs) as
  needed for context.
- Documents all work in the task report.
- Self-assesses success against the task checklist — enumerates the checklist
  items in the report, marking each passed/failed.
- Flags failure honestly when a task cannot be completed.
- **Commits** its changes via the MCP git tool. By convention, commits only
  files it modified for the current task.

## Researcher

**Purpose:** investigate external resources, retrieve documentation, build the
project knowledge base.

**Territory:** `<project>/research/`.

**Inputs:**

- Task description with checklist (from Manager)
- Relevant skills (auto-loaded)

**Outputs:**

- Research artifacts stored in `research/` directory (organized by topic)
- Task report (`stages/<stage-id>/reports/<task-id>.json`)

**Behaviors:**

- Retrieves and files documentation from the internet.
- Can read project code for context. By convention, writes under `research/`
  to avoid collisions with Coder.
- **Can write utility scripts** under `research/` for data processing,
  comparison, or analysis.
- Documents findings in structured research files.
- Self-assesses and flags failures.
- **Convention:** never modifies project source — escalates to the Manager if
  it believes a code change is required.
- **Commits** its changes via the MCP git tool. By convention, commits files
  under `research/` and its task report.

## Data Agent

**Purpose:** acquire, validate, and document external datasets needed by
stages.

**Lifecycle:** one-shot worker dispatched by the Manager via
`run_data_agent(task)`.

**Inputs:**

- Task description (data source criteria, target location, validation
  requirements)
- Relevant skills (auto-loaded)

**Outputs:**

- Data artifacts under project-appropriate locations (`data/`,
  `research/data-sources/`, etc.)
- Provenance notes describing source, retrieval method, license, and
  validation evidence
- Task report (`stages/<stage-id>/reports/<task-id>.json`)

**Behaviors:**

- Searches for real data sources, downloads or queries them, validates the
  result.
- Leakage-aware and reproducible by default; records provenance for every
  artifact.
- May write small helper scripts strictly required to validate a download;
  does not write project source code.
- **Commits** its changes via the MCP git tool.

## TaskReport schema

```ts
interface TaskReport {
  task_id: string;
  status: "completed" | "failed";
  summary: string;
  files_modified: string[];
  tests_added: string[];
  issues_found: string[];
  failure_reason?: string;
  checklist?: ChecklistResult[];
  completed_at: string;
}
```

The Manager evaluates `status` and `checklist` to decide retry vs. escalation.

## Commit conventions

Workers commit their own changes via `git_commit(files, message, task_id)`.
Commit messages follow:

```
[<task_id>] <one-line summary>

<longer details, optional>
```

The Manager does **not** commit. The Planner only commits `.saivage/` state
mutations (plan, history) when those are not already committed by the plan
MCP service.

## Crash recovery

A worker crash (process killed mid-task) leaves `tasks.json` with the task in
`in-progress` status. On restart the Recovery module resets it to `pending`;
the Manager will redispatch on resume.

Because workers commit incrementally and report after committing, partial work
is recoverable from `git log`. The Manager's retry loop is responsible for
noticing duplicate work and adjusting the description.
