# F02 — Agent-facing tools for RAG collection registration and indexing

## Goal (operator statement)

Design and ship the **MCP tool surface** that lets agents (and
operators, via the same tools) **create, configure, and feed** RAG
collections at runtime. Without this layer, the RAG subsystem can only be
driven from TypeScript code or `saivage.json` — agents have no way to
ask "index this folder", "create a new project-docs collection", or
"remember this design note".

## Hard constraints

1. **The RAG subsystem is fixed.** Do not propose changes to
   `src/rag/`. The tool layer composes the existing public surface
   ([saivage/src/rag/index.ts](saivage/src/rag/index.ts)).
2. **Architecture-first, no backward compatibility.** No tool aliases
   "for migration", no soft-deprecation tier — just the new tools.
3. **One namespace, small surface.** All RAG-facing tools live under a
   single MCP service id (e.g. `rag`). Aim for ≤ 8 distinct tools.
4. **Explicit + automatic insertion are both required.**
   - **Explicit:** an agent calls `rag.add` with raw text or a path and a
     target collection.
   - **Automatic:** an agent calls `rag.register` with a `sources` list
     and a `watch` mode; the runtime arms the chokidar watcher (or
     polling) and reconciles on schedule. Manual ingest of an explicit
     batch must still work after the watcher is armed.
5. **Permissions are not optional.** The tool layer must enforce who can
   create collections (writers vs. queriers), who can delete, and which
   paths are forbidden from indexing
   ([saivage/src/mcp/fsGuard.test.ts](saivage/src/mcp/fsGuard.test.ts)).
   Secret-bearing paths are a hard NO regardless of agent role.
6. **No tool may bypass the secret guard.** Every ingest path —
   explicit `rag.add`, path-based `rag.ingest`, watcher-driven — runs
   through `shouldSkipPath` + `scanChunk` from
   [src/rag/security/](saivage/src/rag/security/).
7. **No over-engineering.** Do not invent a "policy DSL" or "indexing
   workflow language". Tool args are plain JSON.

## Required analysis topics

- **Current MCP registration model.** How services get added to the
  builtins list ([saivage/src/mcp/builtins.ts](saivage/src/mcp/builtins.ts)),
  how the runtime applies the per-agent tool whitelist
  ([saivage/src/agents/tool-filters.ts](saivage/src/agents/tool-filters.ts)),
  and how tool errors surface to agents
  ([saivage/src/mcp/types.ts](saivage/src/mcp/types.ts)).
- **What agents actually want to do.** Enumerate the concrete
  operations: register a new collection, list existing collections,
  inspect a collection's stats, ingest a directory, ingest one
  explicit text record, delete a record, query, drop a collection,
  toggle the watcher, force a reconcile. Decide which become tools and
  which are admin-only (CLI / `saivage.json` only).
- **Argument and result schemas.** For each tool: input zod schema,
  output shape, error taxonomy mapped to the existing `RagError`
  hierarchy ([saivage/src/rag/errors.ts](saivage/src/rag/errors.ts)).
- **Authorisation model.** Which agent roles
  ([saivage/src/agents/roster.ts](saivage/src/agents/roster.ts)) may
  call which tool. Default whitelist for new agents.
- **Concurrency and locking.** What happens when two agents call
  `rag.ingest` against the same collection. How the existing per-
  dataset `proper-lockfile` interacts with multiple in-flight tool
  invocations.
- **Failure surface.** What does an agent see when a tool fails: drift,
  flood, watcher-unavailable, dataset-not-found, lock contention,
  embedding provider rate limit. Each error class maps to a tool-level
  error code.
- **Discovery.** How agents find out which collections exist (a list
  tool? prompt injection of available collections at boot? both?).
- **Logging and telemetry.** What gets recorded for an explicit
  `rag.add`, an automatic re-ingest, a failed ingest. Where in the
  runtime logs ([saivage/src/runtime/](saivage/src/runtime/)).

## Required design topics

Two proposals minimum:

- **Focused proposal.** One MCP service `rag` with a tight tool set:
  `rag.list`, `rag.register`, `rag.drop`, `rag.add`, `rag.ingest`,
  `rag.query`, `rag.stats`, `rag.reconcile`. Each handler delegates to
  `createRagManager` / `Dataset` / `runIngest`. Permissions enforced via
  a static per-tool role gate plus `fsGuard` on path arguments.
- **Level-up proposal.** Two services, one read-only (`rag.read` —
  `query`, `list`, `stats`) and one write (`rag.write` — `register`,
  `add`, `ingest`, `drop`, `reconcile`, watcher toggles). The split
  lets the per-agent tool filter grant retrieval-only access to most
  agents and write access only to the operator and the future
  Librarian (F03). Justify or reject vs. the focused proposal.

Both proposals must specify: tool list with zod schemas, file layout
under `src/mcp/`, where the service is registered, the per-agent
whitelist changes, and the error-to-tool-code mapping.

## Required plan topics

- Order the work so the read-only path lands first (lowest-risk
  surface, immediately useful for sanity-checking the new MCP service
  without granting write access to any agent).
- Specify validation: `npm run typecheck`, vitest scoped to new files,
  and at least one integration test exercising a real agent calling
  `rag.query` against a seeded collection.
- Identify rollback strategy: tools are gated behind
  `config.rag.enabled`; removing the service entry from `builtins.ts`
  hides them all.
- Specify the documentation deliverable update in
  [saivage/SPEC/v2/rag/](saivage/SPEC/v2/rag/) — at least a new
  `agent-tools.md`.

## Project rules the dance must respect

- `Architecture-first, no backward compatibility`.
- `implementationDiscipline`.
- ESM + TypeScript on Node 24+.
- All file references are repo-root-relative markdown links.
- Each rN document is self-contained.

## Scope boundaries (do not touch in this dance)

- The RAG subsystem internals.
- The Librarian agent definition itself (covered by F03; this design
  may name it as a future caller, no more).
- Other MCP services (`plan`, `notes`, `httpFetch`, …) — only
  registration of the new service is in scope.
- The web UI.

This file is the source of truth for the dance.
