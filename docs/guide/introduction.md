# Introduction

**Saivage** (a wordplay between *AI* and *savage*) is a self-extending,
autonomous software-engineering agent that runs continuously on a project
directory and pursues a list of objectives until they are met.

Where most LLM "coding assistants" run a tight, interactive loop with the
human in the driver's seat, Saivage is built to operate **unattended**,
suspending only when it needs human input. It does this through a strict
hierarchical chain of command and rigorous separation between transient LLM
state and durable on-disk state.

## What it does

- Reads project objectives from `.saivage/config.json`.
- Generates a multi-stage plan via the **Planner** agent.
- For each stage, spawns a **Manager** that decomposes work into tasks.
- Dispatches **Coder** and **Researcher** workers (sometimes in parallel) for
  individual tasks.
- Inspects, tests, commits, and reviews its own work.
- Surfaces progress through a **web UI** (WebSocket), **Telegram bot**, or
  **CLI**.
- Escalates to the human when stuck (via notifications), and accepts
  steering through user notes.

## Design pillars

1. **Hierarchical delegation.** Each agent has a clearly scoped responsibility
   and communicates via tool calls, not message queues.
2. **Disk is the source of truth.** Every plan, task, report, and skill is a
   JSON document under `.saivage/` (project-local) or in a runtime tmp
   directory. LLM conversations are working memory only.
3. **Crash-recoverable.** A restart can reconstruct execution position from
   disk state. The supervisor loop catches stuck agents.
4. **Multi-provider routing.** Failover between GitHub Copilot, Anthropic,
   OpenAI, OpenAI Codex, Ollama, llama.cpp, OpenRouter, and pi-ai.
5. **Convention over enforcement.** All agents have full filesystem access;
   territorial conventions (Coder = project code, Researcher = `research/`)
   prevent collisions without runtime permission checks.

## What it is *not*

- It is **not a chat assistant**. The web UI's chat is a thin steering layer;
  the real work happens in the Planner → Manager → Worker hierarchy.
- It is **not a sandbox**. Saivage assumes you run it inside a sandbox
  (LXC container is the recommended deployment) — the agents have shell
  access to the project tree and can run arbitrary commands.
- It is **not stateless**. State is project-local under `.saivage/` and must
  be backed up like any other project artifact.

## Where to next

- [Concepts](./concepts) — vocabulary you'll need (stages, tasks, notes…).
- [Quickstart](./quickstart) — a minimal end-to-end run on the host.
- [LXC deployment](./install-lxc) — the recommended production setup.
- [Architecture](/internals/architecture) — start here if you want to read code.
