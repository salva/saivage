# F01 — Migrate skills and memories onto the RAG subsystem

## Goal (operator statement)

Replace the bespoke storage and retrieval paths inside Saivage v2's
**skills** and **memories** subsystems with thin facades over the RAG
subsystem that was just shipped under [saivage/src/rag/](saivage/src/rag/).
Skill matching and memory recall must go through RAG `Dataset`s; the legacy
indexing/lookup code in `src/knowledge/` and `src/mcp/knowledge*.ts` is to
be removed, not preserved alongside.

## Hard constraints

1. **Architecture-first, no backward compatibility.** No migration shim that
   reads the old skill/memory format and the new one. The new format on
   disk is the only format; existing local user/session/repo memories that
   matter are re-indexed from source. There is no "v1 fallback".
2. **The RAG subsystem is fixed.** Do not propose changes to
   `src/rag/` to make the migration easier. If the public surface lacks a
   capability, name the gap as a follow-up and design around it.
3. **No new vector store engines, providers, or chunkers.** Reuse the
   sqlite-vec store, the OpenAI embedding provider, and the existing
   `markdown` / `code` / `memory` chunkers.
4. **Two distinct collections.** Skills are not memories. Each subsystem
   gets its own RAG `Dataset` (own provider stamp, own on-disk store, own
   exclusion set). Cross-collection queries are not in scope.
5. **No degradation of the agent-facing contract.** The MCP tools that
   agents call today (`knowledgeSkills.*`, `knowledgeMemory.*`) keep
   working — their handlers' implementations change but the tool names,
   argument schemas, and result shapes for callers stay stable. Any tool
   surface change must be called out explicitly with rationale.
6. **Opt-in stays opt-in.** Until `config.rag.enabled = true` and the two
   collections are registered, the skill/memory subsystems should refuse
   to start with a clear error — there is no "fall back to flat-file
   search" mode.
7. **No over-engineering.** Do not introduce a new abstraction layer
   between `Dataset` and the consumers if a direct call suffices.

## Required analysis topics

The functional analysis must cover at least:

- **Current state.** What does `src/knowledge/` actually store, how does
  it index, what does it expose? Where does data live on disk today? Which
  agents call which MCP tools and with what argument patterns?
  ([saivage/src/knowledge/](saivage/src/knowledge/),
  [saivage/src/mcp/knowledgeSkills.ts](saivage/src/mcp/knowledgeSkills.ts),
  [saivage/src/mcp/knowledgeMemory.ts](saivage/src/mcp/knowledgeMemory.ts))
- **Schema gap analysis.** Which fields of the current
  skill/memory records map onto `ChunkMetadata`, which need to live in a
  separate sidecar table, and which can be dropped. Justify each drop.
- **Sources to index.** For both skills and memories: which on-disk roots,
  which include/exclude globs, which chunker (likely `memory` for
  memories, `markdown` for skills' YAML+body files). Sample size
  estimates (token counts, file counts) for a representative project.
- **Identity and IDs.** Skills have human IDs (the `name:` in skill
  frontmatter); memories have UUIDs/timestamps. Map these onto chunk
  metadata so `query` results can resolve back to the original record.
- **Permissions / scope.** Memories have a three-tier scope (user /
  session / repo) plus optional permission filters
  ([saivage/src/knowledge/permissions.ts](saivage/src/knowledge/permissions.ts)).
  Show how these collapse onto `QueryFilter`.
- **Lifecycle.** Knowledge has explicit lifecycle transitions
  ([saivage/src/knowledge/lifecycle.ts](saivage/src/knowledge/lifecycle.ts)).
  Specify how archival, deletion, and rotation interact with the RAG
  store's `deleteByFilter` and the watcher's reconcile sweep.
- **Eager loading vs. retrieval.**
  [eagerLoader.ts](saivage/src/knowledge/eagerLoader.ts) hydrates content
  at agent boot. Decide what stays eager (small allowlists like skill
  metadata, hot user memories) and what becomes RAG-on-demand.
- **Backout / removal plan.** Catalogue every file under
  `src/knowledge/` and `src/mcp/knowledge*.ts` and classify as: keep
  (thin façade), rewrite (new RAG-backed implementation), or delete.
- **Failure modes.** What happens when a dataset is unregistered or its
  provider stamp drifts? What does the skill loader do on first boot
  before its dataset has ever been ingested? Specify the exact errors.

## Required design topics

The design document must contain at least two proposals:

- **Focused proposal.** Smallest viable refactor: introduce two
  `Dataset`s (one for skills, one for memories), rewrite the
  `knowledgeSkills` and `knowledgeMemory` MCP handlers as thin wrappers
  over `Dataset.query` + a small sidecar table for permission filters and
  lifecycle state. Delete the legacy storage/indexing code.
- **Level-up proposal.** Introduce a generic "Collection" concept above
  `Dataset`: a content-typed registry that owns the sidecar tables, the
  permission model, and the eager-load allowlist; skills and memories
  become two registered collection kinds. Justify or reject vs. the
  focused proposal.

Both proposals must specify: module layout, on-disk layout under
`<projectRoot>/.saivage/rag/<datasetId>/` and any sidecar files,
configuration surface in `saivage.json`, and the MCP tool surface
post-refactor.

## Required plan topics

The implementation plan must:

- Order the work so foundational pieces (sidecar table, lifecycle
  mapping, ID resolution helpers) come before the actual handler rewrite.
- Specify exact validation: `npm run typecheck`, `npx vitest run` scoped
  to the new files, a manual integration test that exercises a real
  agent calling `knowledgeMemory.search`.
- List every file under `src/knowledge/` and `src/mcp/knowledge*.ts` and
  state whether the batch deletes, rewrites, or keeps it.
- Identify rollback strategy (the migration is gated behind config; a
  failed rollout means rolling back the commit).

## Project rules the dance must respect

- `Architecture-first, no backward compatibility` (workspace rule).
- `implementationDiscipline`: no docstrings/comments in untouched code;
  no helpers for one-time ops.
- ESM + TypeScript on Node 24+.
- All file references use repo-root-relative markdown links.
- Each rN document is self-contained.

## Scope boundaries (do not touch in this dance)

- The RAG subsystem itself
  ([saivage/src/rag/](saivage/src/rag/)) — accept it as-is.
- Agent prompt/role definitions outside the tool surface implementation.
- `src/agents/` internal structure (only the tool whitelist may need a
  trivial entry change, no agent rewrites).
- The web UI.

This file is the source of truth for the dance.
