# Coder & Researcher

[`src/agents/coder.ts`](https://github.com/salva/saivage/blob/main/src/agents/coder.ts) ·
[`src/agents/researcher.ts`](https://github.com/salva/saivage/blob/main/src/agents/researcher.ts)
· spec [§2.3](https://github.com/salva/saivage/blob/main/SPEC/v2/00-AGENT-SYSTEM.md#23-coder)
[§2.4](https://github.com/salva/saivage/blob/main/SPEC/v2/00-AGENT-SYSTEM.md#24-researcher)

The Coder and Researcher are **one-shot worker agents**. The Manager
spawns one (sometimes two — one of each — in parallel) for each task,
and they terminate as soon as they return their `TaskReport`.

## Shared properties

- Same `WorkerInput` shape: `{ task, stageContext }`.
- Same return type `TaskReport`.
- Same tool catalog: filesystem, shell, git, web (when available), memory,
  index. The two roles differ in their **system prompts** and **conventions**,
  not in their permissions.

## Coder

- **Territory**: project source code.
- **Behavior**: reads relevant files, plans the edit, writes code, runs
  tests, commits with a message that includes the task id, then writes the
  `TaskReport`.
- **Self-assessment**: enumerates the task's checklist in the report,
  marking each item passed/failed.

## Researcher

- **Territory**: `<project>/research/`.
- **Behavior**: gathers external information (web fetch, doc retrieval),
  summarizes findings into structured Markdown files under `research/`,
  may write small utility scripts there.
- **Convention**: never modifies project source — escalates to the
  Manager if it believes a code change is required.

## TaskReport

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

The Manager evaluates `status` and `checklist` to decide retry vs.
escalation.

## Commit conventions

Workers commit their own changes via `git_commit(files, message,
task_id)`. Commit messages follow:

```
[<task_id>] <one-line summary>

<longer details, optional>
```

The Manager does **not** commit. The Planner only commits `.saivage/`
state mutations (plan, history) when those are not already committed by
the plan MCP service.

## Crash recovery

A worker crash (process killed mid-task) leaves `tasks.json` with the
task in `in-progress` status. On restart the Recovery module resets it to
`pending`; the Manager will redispatch on resume.

Because workers commit incrementally and report after committing, partial
work is recoverable from `git log`. The Manager's retry loop is responsible
for noticing duplicate work and adjusting the description.
