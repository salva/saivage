# Librarian

[`src/agents/librarian.ts`](https://github.com/salva/saivage/blob/main/src/agents/librarian.ts),
[`prompts/librarian.md`](https://github.com/salva/saivage/blob/main/prompts/librarian.md)

The Librarian is a **bounded steward of unprotected RAG collections**. It
investigates retrieval gaps and drift; registers, ingests, queries, drops, and
diagnoses datasets; and records policy and incident memories under
`topic.domain="rag"`.

## Purpose

Bounded steward of unprotected RAG collections.

## Lifecycle

One-shot, on demand. Dispatched by the Planner or the Manager via
`run_librarian`; returns a markdown report (not a `TaskReport`).

## Scope of action

Bounded by design. The Librarian:

- **Cannot** mutate the plan.
- **Cannot** edit source files.
- **Cannot** invoke `run_command`.
- **Cannot** write skills.
- **Cannot** mutate protected datasets.
- **Can** register, ingest, query, drop, and diagnose unprotected RAG
  collections.
- **Can** write project-scope memories under `topic.domain="rag"` and
  `topic.subject ∈ {policy, secret-incidents, drift-incidents}`.

The permission matrix is enforced in
[`src/knowledge/permissions.ts`](https://github.com/salva/saivage/blob/main/src/knowledge/permissions.ts),
with the Librarian-specific RAG topic guard in
[`src/mcp/knowledgeMemory.ts`](https://github.com/salva/saivage/blob/main/src/mcp/knowledgeMemory.ts).

## Inputs

- Investigation request describing the retrieval gap, drift, or collection
  operation to perform (from Planner or Manager).
- Relevant skills (auto-loaded).

## Outputs

- A **markdown report** returned as the tool result (not a JSON `TaskReport`
  like other workers).
- RAG collection mutations (registrations, ingestions, prunes) applied
  in-place via MCP tools.
- Memory records under `topic.domain="rag"` for durable policy and incident
  recording.

## Behaviors

- Diagnoses retrieval misses by probing the relevant collections.
- Registers and ingests new datasets when stages need them.
- Uses `rag_admin` diagnostics and destructive `rag_drop` only under the
  prompt's confirmation rules.
- Records policy decisions and incidents as project-scope memories so future
  Librarian invocations can build on prior reasoning.

## Tools advertised

- RAG MCP tools (`rag_list`, `rag_stats`, `rag_query`, `rag_register`,
  `rag_ingest`, `rag_drop`, `rag_admin`).
- Memory MCP tools restricted to `topic.domain="rag"` writes (`create_memory`,
  `update_memory`) plus read/search tools (`list_memories`, `get_memory`,
  `search_memories`).
- Filesystem read-only access for inspecting source datasets.

The Librarian does not have access to `run_command`, dispatch tools, skill
write tools, or plan mutation tools.
