# Saivage — Project Overview

## 1. Vision

Saivage is a **self-extending, autonomous AI agent** that runs as a **headless daemon** with an **HTTP/WebSocket API**. At its core is an **Orchestrator** that maintains a structured TODO of work in progress and dispatches tasks to **specialised sub-agents** -- all asynchronously and event-driven.

The Orchestrator never talks to users directly. Instead, it exposes its state and commands as an **Orchestrator MCP service** (tools like `orch.get_todos`, `orch.submit_work`, etc.). **Chat agents** -- one per connected client -- are conversational agents that call the Orchestrator MCP to query state and submit work requests. Chat agents are **read-only**: they can answer questions, search conversations, and read files, but all mutations (file writes, commands, git operations) are routed through the Orchestrator as tracked work items.

Multiple chat sessions run **in parallel**, connecting through the API via different transports: a **Vue web app** (primary), a terminal CLI, or future protocols like Telegram. The Orchestrator is transport-agnostic -- it has no knowledge of users or UIs.

Sub-agents work like modern coding agents (GitHub Copilot, Cursor, Cline): each runs a ReAct loop with tools, skills, and a focused system prompt. When a needed capability does not exist yet, a code-writing sub-agent authors a new MCP service, tests it, and registers it.

The system supports **multiple LLM providers and models** (like OpenClaw's `provider/model-id` pattern), letting each agent use the model best suited for its role. It also supports **teachable skills** -- structured instruction files loaded into agent context on demand.

## 2. Core Principles

| Principle | Description |
|---|---|
| **Autonomous & event-driven** | The orchestrator reacts to events (user messages, agent completions, timers). All sub-agent interaction is async — dispatch and react, never block. |
| **Stateful orchestrator** | The orchestrator maintains a live TODO list of work, agent assignments, and dependencies — injected into every LLM decision call. |
| **Orchestrator + sub-agents** | A headless orchestrator schedules work and exposes state via MCP. Autonomous chat agents handle users. Worker sub-agents execute tasks. Sub-orchestrators manage complex goals. |
| **Self-extending** | When no existing tool can fulfill a task, the agent writes a new MCP service rather than failing. |
| **Self-modifying** | Saivage operates on two projects simultaneously: the target project and itself. It can rewrite its own components — MCP services, agent configs, skills, even core modules — through a sandbox-then-promote pipeline with automatic rollback. |
| **Skill-based** | Agents are teachable via skill files (`SKILL.md`) that inject specialised knowledge and procedures. |
| **Multi-model** | Different providers (Anthropic, OpenAI, Google, Ollama, etc.) and models can be assigned per agent role. |
| **Confined execution** | Runs in an isolated environment where all local actions are allowed (root, network, filesystem). The only security layer is prompt injection defence on external data. |
| **TypeScript-first** | The entire system — orchestrator, sub-agents, generated services — is built in TypeScript on Node.js. |

## 3. Key Concepts

### 3.1 Orchestrator (Autonomous Core)
The top-level controller and **headless daemon**. It maintains a **structured TODO state** -- tasks, their status, assigned agents, dependencies -- and uses this state plus an LLM to decide what to do next on every event. It dispatches work to sub-agents **asynchronously** and can spawn **sub-orchestrators** for complex goals. All state and commands are exposed via the **Orchestrator MCP service** -- chat agents, admin tools, and other components interact with it exclusively through MCP tool calls. See [05-ORCHESTRATOR.md](05-ORCHESTRATOR.md).

### 3.2 Sub-Agents
Autonomous workers modelled after modern coding agents (GitHub Copilot, Cursor). Each runs its own ReAct loop: LLM reasoning -> tool calls -> observe results -> iterate. They have their own system prompt, skill set, model, and tool access. Built-in types:
- **Chat** -- conversational, user-facing agent (one per session). Read-only: queries orchestrator state, searches conversations and files, submits work requests via `orch.submit_work`. Does **not** write files, run commands, or dispatch agents directly.
- **Coder** -- writes and edits code, generates MCP services.
- **Researcher** -- web search, document analysis, information gathering.
- **Planner** -- breaks complex goals into step-by-step plans.
- **Executor** -- runs shell commands, manages deployments.

Worker sub-agents (all except Chat) never talk to the user -- they report to the Orchestrator via async events. See [06-SUB-AGENTS.md](06-SUB-AGENTS.md).

### 3.3 Sub-Orchestrators
For complex multi-step goals, the orchestrator spawns a **child orchestrator** — a full Orchestrator instance with its own TODO list, agent pool, and event loop. Sub-orchestrators report to their parent via events, forming a tree of coordinators. See [05-ORCHESTRATOR.md §9](05-ORCHESTRATOR.md).

### 3.4 Skills
Markdown files (`SKILL.md`) that teach an agent how to perform a specific task or follow a specific process. Skills are loaded into the agent's context on demand. See [07-SKILLS.md](07-SKILLS.md).

### 3.5 Model Providers
A pluggable abstraction over LLM providers. Each agent role can be assigned a different `provider/model` pair with independent auth, failover, and rate-limit handling. See [08-MODEL-PROVIDERS.md](08-MODEL-PROVIDERS.md).

### 3.6 MCP Services
Modular tool servers that speak the Model Context Protocol. Can be built-in, generated by the agent, or installed from external sources. See [09-MCP-GENERATOR.md](09-MCP-GENERATOR.md) and [10-MCP-RUNTIME.md](10-MCP-RUNTIME.md).

## 4. High-Level Flow

```
     Clients (multiple, parallel)
     +----------+----------+----------+
     | Browser  | CLI      | Telegram |
     | (Vue WS) | (stdin)  | (future) |
     +----+-----+----+-----+----+-----+
          |          |          |
          +----------+----------+
                     |
              HTTP + WS API
                     |
                     v
          +--------------------+
          | Session Manager    |  one Chat agent per connection
          +---+--------+---+--+
              |        |   |
              v        v   v
          +------+ +------+ +------+
          |Chat 1| |Chat 2| |Chat N|   autonomous agents
          +--+---+ +--+---+ +--+---+
             |        |        |
             +--------+--------+
                      | orch.* MCP calls
                      v
          +------------------------+
          |     Orchestrator       |
          |  +-----------------+   |
          |  |  TODO State     |   |
          |  |  +--+--+--+    |   |
          |  |  |T1|T2|T3|..  |   |
          |  |  +--+--+--+    |   |
          |  +-----------------+   |
          |  Orchestrator MCP      |
          |  Event loop (async)    |
          +----------+-------------+
                     | dispatch (async, fire-and-forget)
               +-----+-----+----------------+
               v     v     v                v
            Coder Researcher Executor  Sub-Orchestrator
           (ReAct)  (ReAct)  (ReAct)    +-- own TODOs
               |     |     |            +-- own agents
               +-----+-----+            +-- own event loop
                     v
               MCP Runtime -- tool calls to MCP services
                     |
                     v
               Results flow back as events -- orchestrator decides next
```

## 5. Non-Goals (for v0.1)

- Multi-user / multi-tenant operation.
- Cloud-hosted agent (local-first).
- Marketplace or sharing of generated services / skills.

## 6. Document Index

| Document | Purpose |
|---|---|
| [00-OVERVIEW.md](00-OVERVIEW.md) | This document -- vision, concepts, flow |
| [01-FUNCTIONAL-ANALYSIS.md](01-FUNCTIONAL-ANALYSIS.md) | Functional requirements (what the system must do) |
| [02-USE-CASES.md](02-USE-CASES.md) | Use case catalogue (80+ scenarios) |
| [03-ARCHITECTURE.md](03-ARCHITECTURE.md) | Multi-agent architecture decisions |
| [04-COMPONENTS.md](04-COMPONENTS.md) | Component diagram, tech stack, data flow, directory layout |
| [05-ORCHESTRATOR.md](05-ORCHESTRATOR.md) | Event loop, task scheduling, global planning |
| [06-SUB-AGENTS.md](06-SUB-AGENTS.md) | Sub-agent lifecycle, types, communication protocol |
| [07-SKILLS.md](07-SKILLS.md) | Skill format, loading, authoring, built-in skills |
| [08-MODEL-PROVIDERS.md](08-MODEL-PROVIDERS.md) | Multi-provider abstraction, auth, failover, routing |
| [09-MCP-GENERATOR.md](09-MCP-GENERATOR.md) | Code generation pipeline for new MCP services |
| [10-MCP-RUNTIME.md](10-MCP-RUNTIME.md) | Process management, sandboxing, health checks |
| [11-SECURITY.md](11-SECURITY.md) | Threat model, permissions, sandboxing, secrets |
| [12-USER-INTERACTION.md](12-USER-INTERACTION.md) | CLI, approval flows, configuration |
