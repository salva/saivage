# F01 — RAG subsystem for Saivage v2

## Goal (operator statement)

Add a RAG (retrieval-augmented generation) subsystem to Saivage v2 that can serve **multiple, independent document datasets**. Examples of datasets it should be designed to support (without implementing the integrations yet):

- Skills and memories (Saivage's own knowledge base under `src/knowledge/` + `skills/builtin/` + per-project `.saivage/` notes).
- Target-project documentation (e.g. `docs/`, `README.md`, `AGENTS.md`, spec files).
- Target-project source code.

## Hard constraints

1. **Design-only**. No implementation, no PoC, no edits outside this folder (`saivage/SPEC/2026-05/rag-subsystem-design/`).
2. **No integration design** with specific Saivage v2 features (skills loader, memory manager, planner, etc.). Treat those as future consumers; produce a clean library/service surface they will eventually call. Acknowledge integration *impact* where unavoidable, but do not propose changes to the existing skill/memory/runtime code.
3. **Minimalistic**. Avoid heavyweight infra (no Elasticsearch, no separate DB server unless absolutely required). Prefer:
   - An embedded vector store that ships as an npm package or talks to a single small local binary.
   - Good JS/TS ergonomics.
   - Easy to install on Linux (apt or pure-npm preferred; no Docker requirement).
4. **Cheap embeddings, including local option**. The system must be able to use:
   - A hosted embeddings API (OpenAI, Anthropic if available, others) — preferred when cheap.
   - A local embeddings model — feasibility and impact must be analyzed, but *integrating* a local model is **not a deliverable of this work**. Just keep the abstraction open enough to plug one in later.
5. **Architecture-first, no backward compatibility** (workspace-wide rule). No migration shims. No compatibility with hypothetical prior RAG state. Remove (in proposals) anything that would only exist to support a legacy path.
6. **No over-engineering**. Multi-tenancy across datasets is required; sharding, replication, distributed indexing, hybrid BM25+vector reranking, query planners, etc. are *not* required unless the analysis demonstrates they are needed for the stated datasets at realistic Saivage scale.

## Required analysis topics

The functional analysis (`01-analysis-rN.md`) must cover at least:

- **Use cases** for each candidate dataset (skills/memories, target docs, target code) — what queries does Saivage actually need to answer? What is the realistic corpus size (documents, total tokens) for each? What query latency is acceptable?
- **Embeddings provider survey**. For each common Saivage LLM provider (Anthropic, OpenAI, and any others routed via `@mariozechner/pi-ai`), state explicitly whether they offer an embeddings API today, the model names, dimensions, pricing, and rate limits. Identify which is cheapest at Saivage scale.
- **Local embedding options** (e.g. `@xenova/transformers`, `fastembed`, `llama.cpp` server, Ollama embeddings endpoint). Compare install/runtime cost, dimensions, quality, and JS/TS integration story. Recommendation must be "designed-in but not implemented".
- **Vector store options** for embedded JS/TS use. Candidates to consider: `sqlite-vec` (SQLite extension), `vectordb` / LanceDB Node bindings, `hnswlib-node`, `chromadb` (embedded mode), `qdrant` (local server), `pgvector` (requires Postgres). For each: install footprint on Linux, JS/TS API quality, persistence model, multi-collection support, filterable metadata, ANN algorithm, scaling ceiling, license. Score against the constraints.
- **Chunking and ingestion**. Strategies for code vs. markdown vs. memory notes; chunk size guidance; metadata schema; idempotent re-indexing; change detection (mtime / content hash); deletion handling.
- **Public surface**. What library/service API would the future consumers call? At minimum: dataset registration, ingest (add/update/delete documents), query (top-k with filters), and lifecycle (rebuild, drop). Keep it small.
- **Failure modes and security**: provider outages, embedding model drift (dimension change → reindex), poisoned content, accidental indexing of secrets (e.g. `.saivage/auth-profiles.json`), running inside Saivage's existing fastify process vs. as a sidecar.

## Required design topics

The design document (`02-design-rN.md`) must include **at least two proposals**:

- A **focused** design that adds the smallest viable RAG library/module to Saivage v2, picking one default vector store and one default embeddings provider, with the abstraction seams needed for later swap-in.
- A **"one conceptual level up"** alternative that may restructure adjacent code or add a new architectural layer (e.g. a generic "content store" the existing skills/memory subsystem could later migrate onto, or an out-of-process service with an MCP interface). It should be clearly worth the extra cost or clearly rejected with reasons.

Both proposals must specify: module layout, data flow, on-disk layout (per-project `.saivage/rag/...`), configuration surface (`saivage.json` keys), and how multiple datasets are isolated.

## Required plan topics

The implementation plan (`03-plan-rN.md`) must:

- Order the work so foundational/transversal pieces (types, store abstraction, config) come first; the cheapest-to-verify slice ships before any dataset-specific code.
- Stop short of integrating with skills/memories/docs/code consumers — those are listed as **explicit non-goals** with a forward pointer to a future spec.
- Specify exact validation commands (`npm run typecheck`, `vitest run` scoped to new files, manual ingest smoke test).
- Identify rollback strategy (the feature is opt-in via config; absence of config = subsystem disabled).

## Project rules the dance must respect

- `Architecture-first, no backward compatibility` (user memory `preferences.md`).
- `implementationDiscipline`: no docstrings/comments in untouched code; no helpers for one-time ops; no speculative error handling.
- Saivage v2 runs on the latest stable Node.js (>= 24, current LTS at design time) with ESM and TypeScript. The prior `"engines": { "node": ">=20.0.0" }` pin in [saivage/package.json](saivage/package.json) is to be raised as part of this work — analysis and design must assume Node 24+ APIs (including `node:sqlite` if it helps, `worker_threads` improvements, native `fetch`, etc.). Do NOT design around Node 20 limitations. Dependencies must be ESM-friendly and must have working prebuilt binaries for current Node on Linux x64.
- No new files outside `saivage/SPEC/2026-05/rag-subsystem-design/`.
- All file references in generated docs use repo-root-relative markdown links (`saivage/...#Lnn`).
- Each `rN` document is self-contained — no "as in r1", no references to reviewer / APPROVED markers, no allusions to the dance itself (per the skill's "Autonomous documents" rule).

## Scope boundaries (do not touch in this dance)

- Existing `src/knowledge/` code.
- Existing skills loader / memory manager.
- Existing agents, runtime, server modules.
- Concurrent uncommitted work in `src/agents/` (another agent is active there).

This file is the source of truth for the dance. Refinements to scope go in this file, not in the rN documents.
