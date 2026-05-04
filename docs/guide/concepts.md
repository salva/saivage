# Concepts

A short glossary of the vocabulary used throughout Saivage. Each term links to
its detailed treatment in the internals section.

## Project

A **target project** is a directory with a `.saivage/config.json` file
declaring objectives. Saivage operates on this directory: it reads, writes,
runs commands, and commits inside it.

```
my-project/
├── .saivage/                    # Saivage state (mostly committed to git)
│   ├── config.json              # objectives & runtime settings
│   ├── plan.json                # active plan (Planner-managed)
│   ├── plan-history.json        # archived stages
│   ├── stages/<stage-id>/       # per-stage tasks and reports
│   ├── notes/                   # user notes
│   ├── inspections/             # inspection reports
│   ├── skills/                  # learned project-specific skills
│   ├── tools/inspector/         # persistent inspector tools
│   └── tmp/                     # gitignored runtime state
├── src/
└── …
```

See [On-disk layout](/internals/on-disk-layout) for the full schema.

## Objectives

Free-form goal statements stored in `config.json`. The Planner decomposes
them into stages.

```json
{
  "project_name": "my-project",
  "objectives": [
    "Build a REST API with /users and /sessions endpoints.",
    "Use JWT for authentication.",
    "Reach >80% line coverage."
  ]
}
```

## Stage

A **stage** is a named milestone in the project plan. It has a single
objective, a list of expected outcomes, acceptance criteria, and references to
documents the Manager should read before decomposing it. The Planner manages
the active list of stages; each completed stage is archived to plan history.

## Task

A **task** is the atomic unit of work executed by a worker (Coder or
Researcher). Tasks have a type (`code`, `research`, `test`, `document`), a
description, a checklist, dependencies, and a status. Managers create tasks;
workers consume them.

## Worker / Subagent

The **Coder** and **Researcher** agents are workers. They are one-shot —
spawned for a single task, terminated on report. They have full filesystem
and shell access but observe territorial conventions.

## Inspector

A one-shot agent for **deep analysis** of project state. The Planner or Chat
can dispatch the Inspector with a free-form scope. It produces an
`InspectionReport` saved under `.saivage/inspections/`.

## Chat agent

A user-facing agent (one per channel: web UI, Telegram, …). It can read state,
create user notes, and dispatch the Inspector — but cannot modify project code
or the plan directly.

## User note

A piece of free-form input from the human. Notes are stored as JSON files in
`.saivage/notes/` and surfaced to the Planner the next time it resumes.

- **Permanent** notes persist across replans (lightweight objective tweaks).
- **Urgent** notes abort the active agent chain and immediately resume the
  Planner.

## Skill

A reusable knowledge entry — typically a Markdown file under
`.saivage/skills/` with a YAML frontmatter index. Skills are auto-attached to
agents based on tags. See [Skills](./skills).

## MCP service

A Model Context Protocol service that exposes tools to agents — filesystem,
shell, git, plan management, notes, skills. Built-in services run in-process;
external services run as subprocesses (stdio) or remote (SSE).

## Provider / Router

An LLM **provider** is a vendor implementation (Anthropic, OpenAI, GitHub
Copilot, Ollama…). The **router** maps agent role + project routing config to
a concrete provider+model, with retry, failover, and rate-limit awareness.
See [Provider Router](/internals/provider-router).

## Runtime / Dispatcher

The **runtime** is the singleton that owns all agent conversations and
schedules tool-call dispatches between them. Sub-pieces include the
**Dispatcher** (suspend/resume), **Compaction** (context shrinking),
**Self-Check** (loop detection), **Abort** (urgent-note handler), and
**Recovery** (crash recovery).

Continue with the [Quickstart](./quickstart).
