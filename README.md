# Saivage

Self-extending autonomous AI software-engineering agent.

A hierarchical multi-agent system that plans, codes, researches, reviews, and
self-improves — running continuously on your projects.

## Documentation

Full documentation is available at **[salva.github.io/saivage](https://salva.github.io/saivage/)**.

Sections:

- [Guide](https://salva.github.io/saivage/guide/introduction.html) — installation, configuration, operation
- [Internals](https://salva.github.io/saivage/internals/architecture.html) — architecture, agents, runtime
- [API Reference](https://salva.github.io/saivage/api/) — TypeDoc-generated module docs

When running, the docs are also available from the web UI at `/docs/`.

## Quick Start

```bash
npm install
npm run build
node dist/cli.js serve /path/to/your/project
```

Open `http://localhost:8080` for the dashboard, `http://localhost:8080/docs/` for
documentation.

## Development

```bash
npm run dev          # Start server with tsx (hot-reload)
npm run test         # Run tests
npm run typecheck    # Type-check without emitting
npm run lint         # ESLint
npm run docs:dev     # VitePress dev server for docs
npm run docs:build   # Build static docs
```

## Architecture

Saivage runs as a Fastify HTTP + WebSocket server managing a hierarchy of LLM
agents:

- **Planner** — long-lived agent that decomposes project objectives into stages
- **Manager** — executes one stage, breaking it into tasks
- **Coder / Researcher** — worker agents that execute individual tasks
- **Inspector** — deep analysis and auditing
- **Chat** — user-facing conversation agent
- **Reviewer** — code review and quality checks

The runtime includes a dispatcher, supervisor, abort/recovery, compaction, and
MCP service integration. All durable state lives on disk under `.saivage/`.

Project knowledge — both procedural (skills) and factual (memories) — lives under
`.saivage/{skills,memory}/{project,stages,sessions}/` and is authored exclusively via
MCP tools (`create_skill`, `create_memory`, lifecycle ops). See
[docs/internals/knowledge/skills-and-memory.md](docs/internals/knowledge/skills-and-memory.md)
for the conceptual reference and authoring conventions.

## Saivage v3

The next major version is developed at
[salva/saivage-v3](https://github.com/salva/saivage-v3). It features a
redesigned runtime with auto-dispatch, permission matrices, card-based work
tracking, and a richer web UI.

## License

Private — all rights reserved.
