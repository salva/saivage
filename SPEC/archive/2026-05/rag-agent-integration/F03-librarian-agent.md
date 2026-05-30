# F03 — Librarian agent

## Goal (operator statement)

Introduce a dedicated **Librarian** agent whose sole responsibility is to
**curate the workspace's RAG collections**: register them, decide what
gets indexed, keep watcher configurations healthy, prune stale or
poisoned content, and answer cross-collection lookup questions from
other agents. The Librarian is the only agent (besides the operator)
that holds write access to the RAG tool surface; all other agents are
limited to read tools.

## Hard constraints

1. **The Librarian uses only existing seams.** Register through
   [saivage/src/agents/roster.ts](saivage/src/agents/roster.ts), prompt
   through [saivage/src/agents/prompts.ts](saivage/src/agents/prompts.ts),
   tool whitelist through
   [saivage/src/agents/tool-filters.ts](saivage/src/agents/tool-filters.ts).
   No new agent framework.
2. **Architecture-first, no backward compatibility.** No fallback path
   "for agents that don't know about the Librarian". If a dispatcher or
   workflow expected to talk to the legacy skill/memory tools directly,
   it is updated, not double-supported.
3. **Single seat.** There is exactly one Librarian role; no
   per-collection Librarians. The agent decides per-call which
   collection a request concerns.
4. **No autonomous mutation of source content.** The Librarian indexes
   files; it never edits user files. Its write tools are limited to RAG
   collection state (`register`, `add`, `ingest`, `drop`, `reconcile`,
   watcher toggles).
5. **No over-engineering.** No "Librarian state machine". The Librarian
   is a regular agent with a focused prompt; its memory is the same RAG
   memory dataset every other agent uses.

## Required analysis topics

- **Responsibilities.** Enumerate the bounded set of decisions the
  Librarian owns: when to create a new collection, which sources go
  in, watcher mode (native vs. polling vs. off), reconcile cadence,
  pruning rules, response to drift/corruption errors, response to
  flood reports, secret-leak follow-up.
- **Dispatch.** How other agents reach the Librarian:
  - As a fallback when their own retrieval returns nothing relevant.
  - On explicit handoff from the supervisor
    ([saivage/src/runtime/supervisor.ts](saivage/src/runtime/supervisor.ts))
    or the dispatcher
    ([saivage/src/runtime/dispatcher.ts](saivage/src/runtime/dispatcher.ts)).
  - On operator request via chat.
  Compare these dispatch paths.
- **Tool whitelist.** Which tools the Librarian needs (write-side RAG
  tools, file read tools, the planner). Which it must NOT have
  (shell, git push, code edit).
- **Prompt and conventions.** What the system prompt must communicate:
  the read-only-vs-write split, the no-source-edits rule, how to phrase
  collection summaries, the canonical RAG error vocabulary.
- **Knowledge integration.** Whether the Librarian itself uses the
  memory collection to persist decisions (e.g. "we standardised on
  `chunker:markdown` for this collection because…"). Specify the kind
  of memory and the scope (user/session/repo).
- **Failure handling.** What the Librarian does on
  `EmbeddingDriftError`, `WatcherUnavailableError`, `IngestLockedError`,
  `ConfigDriftError`. Decision tree per error.
- **Conflict with the human operator.** When the operator manually
  edits `saivage.json` to change a collection's config, how the
  Librarian reconciles its view.

## Required design topics

Two proposals minimum:

- **Focused proposal.** One agent registered in `roster.ts`, prompt in
  `prompts.ts`, tool whitelist gives it `rag.*` (write side) plus
  `fs.readFile`/`fs.listDir`. Dispatched to from other agents via the
  existing handoff mechanism
  ([saivage/src/agents/handoff.ts](saivage/src/agents/handoff.ts)).
  No new runtime code.
- **Level-up proposal.** The Librarian is also wired as a
  retrieval-augmentation hook in the dispatcher: when no agent matches
  a request and the request contains a retrieval signal (e.g.
  "what does the doc say about X"), the dispatcher routes
  automatically. Justify or reject vs. the focused proposal — the
  level-up means new code in `runtime/dispatcher.ts`.

Both proposals must specify: agent declaration record, prompt outline,
tool whitelist diff, handoff entry points, and the memory the agent is
expected to persist between calls.

## Required plan topics

- Order the work so the agent ships in a minimal form (one prompt, one
  tool whitelist, one roster entry) BEFORE the dispatcher integration
  in the level-up path.
- Specify validation: `npm run typecheck`, vitest for the agent in
  isolation (mock the RAG tools), and a manual end-to-end exercise
  where a different agent hands off to the Librarian to register and
  ingest a small fixture collection.
- Identify rollback strategy: removing the roster entry hides the
  Librarian; the dispatcher fallback (if implemented) is gated on its
  presence.
- Specify the documentation deliverable update in
  [saivage/SPEC/v2/rag/](saivage/SPEC/v2/rag/): a new
  `librarian.md` describing the agent's contract.

## Project rules the dance must respect

- `Architecture-first, no backward compatibility`.
- `implementationDiscipline`.
- ESM + TypeScript on Node 24+.
- All file references are repo-root-relative markdown links.
- Each rN document is self-contained.

## Scope boundaries (do not touch in this dance)

- The RAG subsystem internals.
- The MCP tool surface (covered by F02; this design names the tools
  but does not redesign them).
- The skill/memory migration (covered by F01).
- The web UI.
- Concurrent uncommitted work in `src/agents/` if any other agent is
  active there.

This file is the source of truth for the dance.
