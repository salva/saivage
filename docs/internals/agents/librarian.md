# Librarian

[`src/agents/librarian.ts`](https://github.com/salva/saivage/blob/main/src/agents/librarian.ts)

The Librarian is a **bounded steward of unprotected RAG collections**. It
investigates retrieval gaps and drift; registers, ingests, queries, prunes, and
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
- **Can** register, ingest, query, prune, and diagnose unprotected RAG
  collections.
- **Can** write project-scope memories under `topic.domain="rag"` and
  `topic.subject ∈ {policy, secret-incidents, drift-incidents}`.

The full permission matrix is enforced in
[`src/knowledge/permissions.ts`](https://github.com/salva/saivage/blob/main/src/knowledge/permissions.ts).

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
- Prunes stale or low-quality records from unprotected collections.
- Records policy decisions and incidents as project-scope memories so future
  Librarian invocations can build on prior reasoning.

## Tools advertised

- RAG MCP tools (`rag_register_collection`, `rag_ingest`, `rag_query`,
  `rag_prune`, etc.).
- Memory MCP tools restricted to `topic.domain="rag"` writes (`create_memory`,
  `update_memory`, `archive_memory`, `search_memories`).
- Filesystem read-only access for inspecting source datasets.

The Librarian does not have access to `run_command`, dispatch tools, skill
write tools, or plan mutation tools.
