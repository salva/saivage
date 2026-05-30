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
│   ├── config.json              # objectives, routing, and agent knobs
│   ├── saivage.json             # runtime/provider/MCP/RAG settings
│   ├── plan.json                # active plan + embedded history
│   ├── auth-profiles.json       # OAuth profiles (sensitive)
│   ├── telegram-subscriptions.json
│   ├── stages/<stage-id>/       # per-stage tasks and reports
│   ├── notes/                   # user notes
│   ├── inspections/             # inspection reports
│   ├── knowledge/store.sqlite   # skills and memories
│   ├── rag/                     # RAG registry and dataset stores
│   ├── tools/inspector/         # persistent inspector tools
│   └── tmp/                     # gitignored runtime state
├── src/
└── …
```

See [On-disk layout](/internals/data/on-disk-layout) for the full schema.

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
the active list of stages; each completed stage is archived to the `history`
array inside `plan.json`.

## Task

A **task** is the atomic unit of work executed by a worker. Tasks have a type
(`code`, `research`, `data`, `review`, `test`, `document`, `design`, or
`critique`), a description, a checklist, dependencies, and a status. Managers
create tasks; workers consume them.

## Worker / Subagent

The **Coder**, **Researcher**, and **Data Agent** are one-shot workers spawned
for a single task and terminated on report. **Reviewer**, **Designer**, and
**Critic** are stage-scoped workers that can retain context across follow-up
tasks within a stage. All workers observe role-specific tool filters and
territorial conventions.

## Inspector

A one-shot agent for **deep analysis** of project state. The Planner or Chat
can request deep analysis, but the Planner owns Inspector dispatch. Inspector
produces an `InspectionReport` saved under `.saivage/inspections/`.

## Chat agent

A user-facing agent (one per channel: web UI, Telegram, …). It can read state
and create user notes for the Planner, including requests for deep analysis,
but cannot modify project code, edit the plan, or dispatch workers directly.

## User note

A piece of free-form input from the human. Notes are stored as JSON files in
`.saivage/notes/` and surfaced to the Planner the next time it resumes.

- **Permanent** notes persist across replans (lightweight objective tweaks).
- **Urgent** notes are high-priority Planner input; they do not by themselves
  abort running work.

## Skill

A reusable knowledge entry stored in `.saivage/knowledge/store.sqlite`. Skills
are created and maintained through MCP tools and can be auto-attached to agents
based on triggers and target roles. See [Skills](./skills).

## MCP service

A Model Context Protocol service that exposes tools to agents — filesystem,
shell, git, plan management, notes, skills/memory, RAG, and related runtime
surfaces. Built-in services run in-process; external services run as
subprocesses (stdio) or remote (SSE).

## Provider / Router

An LLM **provider** is a vendor implementation (Anthropic, OpenAI, GitHub
Copilot, Ollama…). The **router** maps agent role + project routing config to
a concrete provider+model, with retry, failover, and rate-limit awareness.
See [Provider Router](/internals/providers/router).

## Runtime / Dispatcher

The **runtime** is the singleton that owns model routing, MCP services, event
delivery, plan services, agent registry, and runtime state. Sub-pieces include
the **Dispatcher** (tool-call execution), **Compaction** (context shrinking),
**Self-Check** (loop detection), **Supervisor** (stuck-agent cancellation), and
**Recovery** (crash recovery).

Continue with the [Quickstart](./quickstart).
