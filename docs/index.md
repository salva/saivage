---
layout: home

hero:
  name: Saivage
  text: Self-extending autonomous AI agent
  tagline: A hierarchical multi-agent system that plans, codes, researches, reviews, and self-improves — running continuously on your projects.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/introduction
    - theme: alt
      text: Architecture
      link: /internals/architecture
    - theme: alt
      text: API Reference
      link: /api/

features:
  - icon: 🧭
    title: Hierarchical agent system
    details: A long-lived Planner delegates stages to Managers, who decompose work into tasks for Coder and Researcher subagents. Inspector and Chat agents handle deep analysis and user interaction.
    link: /internals/agents
    linkText: Agent system
  - icon: 💾
    title: Disk is the source of truth
    details: All durable state lives on disk as JSON documents under .saivage/. LLM conversations are transient working memory — every restart can recover from disk.
    link: /internals/on-disk-layout
    linkText: On-disk layout
  - icon: 🔌
    title: Multi-provider LLM routing
    details: GitHub Copilot, Anthropic, OpenAI, OpenAI Codex, Ollama, llama.cpp, OpenRouter, pi-ai. Per-role overrides, automatic failover, retry with exponential backoff.
    link: /guide/providers
    linkText: Providers
  - icon: 🛠️
    title: MCP-based tool runtime
    details: Filesystem, shell, git, plan, notes, and skill services exposed to agents through the Model Context Protocol. Built-in services run in-process; external servers are supported.
    link: /internals/mcp-services
    linkText: MCP services
  - icon: 💬
    title: Multiple channels
    details: Steer the agent from the web UI (WebSocket), Telegram bot, or one-shot CLI commands. User notes and urgent aborts integrate cleanly with the runtime.
    link: /guide/web-ui
    linkText: Web dashboard
  - icon: 🛡️
    title: Crash-recoverable & sandboxed
    details: Designed to run inside an LXC container with bind-mounted source. Supervisor restarts the planner after compaction failures; abort/recovery rolls back the working tree.
    link: /guide/install-lxc
    linkText: LXC deployment
---

## What is Saivage?

Saivage takes a project directory containing a list of objectives and runs an
autonomous loop of LLM agents that plan, write code, run tests, research APIs,
and report back. It is designed to operate **continuously** in the background,
escalating to a human only when it gets stuck.

```bash
saivage init ./my-project --name my-project \
  --objectives "Build a REST API with JWT auth" "Write integration tests"
saivage start ./my-project
```

While running, Saivage:

1. The **Planner** reads `.saivage/config.json` and produces a multi-stage plan.
2. For each stage, it spawns a **Manager** that decomposes the stage into tasks.
3. The Manager dispatches **Coder** and **Researcher** workers (in parallel
   when possible) for individual tasks.
4. Failures cascade upward: a worker reports failure → the Manager retries or
   escalates → the Planner replans.
5. The user can intervene at any time via notes (web UI, Telegram, CLI). Urgent
   notes abort the active chain and replan immediately.

## Where to next?

- New users: [Quickstart](/guide/quickstart) — install, configure, run.
- Operators: [LXC deployment](/guide/install-lxc) — production-style sandboxed install.
- Contributors and curious readers: [Architecture](/internals/architecture) followed
  by the [Agent System](/internals/agents) and [Runtime Core](/internals/dispatcher).
- Library consumers: the [API Reference](/api/) is generated from TypeDoc.
