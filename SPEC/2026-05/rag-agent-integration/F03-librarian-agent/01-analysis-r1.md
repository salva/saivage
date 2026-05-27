# F03 — Librarian agent: functional analysis

## 1. Why the agent exists

Three F01/F02 facts force the existence of a Librarian role:

1. The skill/memory datasets are **protected** — only the records
   layer (and the runtime reconcile helper) mutate them. Every other
   dataset is operator-or-Librarian-owned. Without a Librarian, the
   operator becomes the only entity that can register, configure, or
   prune additional collections, and every agent that wants a new
   collection has to interrupt the human.
2. The F02 tool surface enforces a role floor where write-side tools
   (`add`, `ingest`, `reconcile`, `register`, `drop`, watcher
   controls) are allowed to **librarian, planner, manager**. Without
   a Librarian to absorb routine curation work, every collection
   decision flows through the planner or manager — agents whose job
   is to plan project work, not to think about embeddings.
3. The watcher controller writes structured warnings on
   `WatcherUnavailableError`, flood detection, and stale stamps. There
   is currently no agent whose job it is to read and act on those
   warnings.

The Librarian's scope is bounded and boring: a single agent that
curates collections, answers cross-collection lookup questions, and
follows up on RAG-subsystem incidents. It does not plan project work
and it does not edit user files.

## 2. Responsibilities

### 2.1 Decisions the Librarian owns

- **Collection creation.** When another agent's request implies a new
  knowledge source (e.g. "search the project docs"), the Librarian
  decides whether an existing collection already covers it, registers
  a new one if not, and configures `sources`, `chunker`, and `watch`.
- **Source curation.** Per collection: which roots to include, which
  to exclude, which chunker, which provider/dim. Decisions are
  persisted as memory records (scope `project`,
  `survive_compaction: true`) so other agents can read the
  Librarian's reasoning.
- **Watcher mode.** Native vs. polling per filesystem. Bind-mount /
  NFS detection by inspecting the root's mount type at decision time
  (Linux: `/proc/self/mountinfo`).
- **Reconcile cadence.** When the watcher is off, the Librarian
  schedules a periodic reconcile via the planner (it does not own a
  scheduler; it asks the planner to add a recurring stage).
- **Pruning.** On a `WatcherUnavailableError` or repeated
  `IngestLockedError`, the Librarian investigates and either lowers
  the source scope, switches the watcher mode, or drops the
  collection (after operator confirmation).
- **Secret-incident follow-up.** When `chunksDroppedSecrets` > 0 on
  an ingest report, the Librarian writes a memory at scope `project`
  identifying which dataset and roughly which directory tripped the
  scanner (no record of the offending content — the runtime never
  logs it).

### 2.2 Decisions the Librarian does NOT own

- Project planning, stage decomposition, code-edit decisions.
- Editing user files. The Librarian indexes; the planner / coder
  edit.
- Choice of embedding model. The Librarian uses what
  `config.rag.datasets` and the operator's policy say; if no policy
  is set, it picks the default openai text-embedding-3-large @ 1536
  matching skills/memories.
- The records layer for skills and memories. Those flow through the
  F01 records APIs, not through `rag.write.*`.

## 3. Dispatch — how other agents reach the Librarian

### 3.1 Existing handoff seam

[saivage/src/agents/handoff.ts](saivage/src/agents/handoff.ts) is the
agent-to-agent handoff API. An agent constructs a `Handoff` envelope
naming the destination role, attaches a request payload, and the
runtime swaps execution to the destination agent's session.

### 3.2 Triggers

The Librarian is reached in four ways:

1. **Explicit handoff.** An agent that decides it needs RAG curation
   work done (planner, manager, researcher) hands off with a payload
   describing the intent.
2. **Operator request.** The chat agent recognises operator-spoken
   intents ("index the project docs", "what's in our memory about X")
   and routes them via handoff.
3. **Retrieval fallback.** When the planner or researcher runs
   `rag.query` and gets zero relevant hits, it may hand off with the
   query text and the targeted collection ids; the Librarian decides
   whether to expand the search to other collections, register a new
   collection, or report that no relevant content exists yet.
4. **Incident routing.** The runtime's RAG error logger (a new small
   module added by F03) writes a session memory and surfaces the
   incident on the supervisor's queue; the supervisor hands off to
   the Librarian to investigate.

The dispatcher
([saivage/src/runtime/dispatcher.ts](saivage/src/runtime/dispatcher.ts))
is not modified in the focused proposal. The level-up proposal adds
an auto-routing hook there; it is rejected if the explicit handoff
paths cover the use cases.

## 4. Tool whitelist

The Librarian gets:

- `rag.read.*` — `list`, `stats`, `query`.
- `rag.write.*` — `add`, `ingest`, `reconcile`, `watch.arm`,
  `watch.disarm`.
- `rag.admin.*` — `register`, `drop`. The only non-operator agent
  with these.
- `fs.readFile`, `fs.listDir`, `fs.statFile` — to inspect candidate
  sources before registering.
- The knowledge tools' read side: `search_skills`, `search_memories`,
  `list_skills`, `list_memories`, `read_skill_by_id`, `get_memory` —
  to look up its own past decisions and any operator policy memories.
- The knowledge tools' write side LIMITED: `create_memory`,
  `update_memory`, `archive_memory` at scope `project`. The Librarian
  records its decisions as project-scope memories; it does not create
  skills (those are higher-leverage and the planner or designer owns
  them).
- The planner's `propose_stage` tool — to ask the planner to schedule
  recurring reconciles.

The Librarian does NOT get:

- Shell tools (`shell.run_command`).
- Code-edit tools (`fs.writeFile`, `fs.applyPatch`).
- Git tools (`git.push`, `git.commit`).
- Subprocess spawning of any kind.

The whitelist edits in
[`tool-filters.ts`](saivage/src/agents/tool-filters.ts) are an
additive role entry; no existing roles change.

## 5. Prompt and conventions

### 5.1 Static prompt content

The Librarian's system prompt
([new key in `prompts.ts`](saivage/src/agents/prompts.ts)) communicates:

- Its bounded role ("you curate retrieval collections; you do not
  plan, do not edit code, do not commit").
- The split between protected (`skills`, `memories`) and unprotected
  datasets.
- The read-vs-write tier on `rag.*` and which tool to reach for which
  job.
- A canonical decision tree for "should I register a new collection?"
  (yes only if no existing collection's `description` covers the
  question and the source content is durable).
- The error vocabulary (the F02 error codes) and the response per
  code (drift → drop+re-ingest; provider unavailable → retry with
  exponential backoff; watcher unavailable → switch to polling).
- The policy: every collection-changing decision is journaled via
  `create_memory` at scope `project` with a `reason`.

### 5.2 Conventions injection

A new fragment in
[`src/agents/conventions.ts`](saivage/src/agents/conventions.ts) is
injected into the Librarian's runtime context at the start of every
turn:

- Output of `rag.list` (datasets currently registered).
- Top-N most-recently-written project memories tagged with
  `domain: "rag-policy"` — the Librarian's accumulated curation
  decisions.
- The current value of `config.rag.datasets[*].id` — for detecting
  config-vs-registry drift.

The fragment is < 1 kB on a typical project; it does not pressure the
agent's context budget meaningfully.

## 6. Persistent state — how the Librarian remembers

The Librarian keeps decisions in the `memories` dataset (the same one
F01 manages) at scope `project` with a stable topic shape:

```
topic: { domain: "rag-policy", subject: "<datasetId>", aspect?: "<event>" }
```

Examples:

- `{ domain: "rag-policy", subject: "project-docs", aspect: "registration" }`
  — body: "registered on 2026-06-04 with chunker:markdown, watch:false (LXC bind-mount; polling impractical at 5s for 12k files); operator approved."
- `{ domain: "rag-policy", subject: "project-docs", aspect: "secret-incident" }`
  — body: "ingest on 2026-06-07 dropped 3 chunks under docs/internal; recommended adding `docs/internal/**` to exclude list. Coordinated with operator."
- `{ domain: "rag-policy", subject: "<id>", aspect: "drift" }` — body
  with the drift error, the recovery action taken, the resulting
  provider stamp.

These memories are not user-facing; they are the Librarian's audit
trail and the source the conventions-injection fragment reads.

## 7. Failure handling — decision tree

| Error code from a RAG tool                                | Librarian action                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `DATASET_NOT_FOUND` on `query`                            | Run `rag.list`; pick a likely-relevant existing collection; if none, hand back to caller with explanation. |
| `EMBEDDING_DRIFT` / `CONFIG_DRIFT` / `STORE_CORRUPTED`    | Write a memory (`aspect: "drift"`); call `rag.drop`; call `rag.register` with the new config; run `rag.ingest` on the source list. |
| `PROVIDER_UNAVAILABLE`                                    | Wait `retryAfterMs`; retry once; on second failure, write a memory and report to caller.                  |
| `INGEST_LOCKED`                                           | Wait `retryAfterMs`; retry once; on second failure, write a memory ("contention spike — investigate"). |
| `WATCHER_UNAVAILABLE`                                     | `rag.drop`-and-reregister with `watch: { usePolling: true }`; write a memory.                             |
| `SECRET_DETECTED` (from `add`)                            | Decline the request; tell the caller; do not retry without a new payload.                                 |
| `PATH_OUTSIDE_PROJECT`                                    | Decline the request; tell the caller to use an in-project path.                                           |
| `PROTECTED_DATASET`                                       | Decline; redirect the caller to the knowledge tools.                                                       |
| Unexpected `RagError` subclass                            | Log + write an incident memory; bubble back to caller.                                                     |

The decision tree is implemented in the system prompt, not in code —
the Librarian is an LLM agent, not a state machine. The runtime
provides the inputs; the agent reasons.

## 8. Operator interaction

The operator interacts with the Librarian via the chat agent. Typical
intents and the Librarian's response:

- "Index the project docs." → `rag.register` if needed,
  `rag.ingest`, report.
- "What collections do you maintain?" → `rag.list` with the
  project-memory annotations.
- "Drop the foo collection." → confirm intent, then `rag.drop` + memory.
- "Why did the watcher fail yesterday?" → `search_memories` for
  `domain: "rag-policy"`, return the relevant journaled entry.

The operator can always bypass the Librarian by editing
`saivage.json` directly; the startup-time `RAG_CONFIG_DRIFT` check
makes the divergence visible. The Librarian's response to a drift is
to read the new config, reconcile, and write a `aspect: "operator-edit"`
memory.

## 9. Conflict with planner ownership

The planner already owns "what task to do next". The Librarian does
not propose stages; it asks the planner to add reconcile-related
stages via `propose_stage`. The planner accepts or declines based on
the project's stage-graph rules. The Librarian never edits the plan
directly.

The handoff direction is therefore always planner → librarian (or
manager → librarian), never the reverse. The Librarian's response is
either a returned report or a `propose_stage` for the planner to
process.

## 10. Files to add / modify

| File                                                | Action                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| [src/agents/roster.ts](saivage/src/agents/roster.ts)| add `librarian` role entry pointing at the new prompt key                    |
| [src/agents/types.ts](saivage/src/agents/types.ts)  | extend `AgentRole` union with `"librarian"`                                  |
| [src/agents/prompts.ts](saivage/src/agents/prompts.ts) + [prompt-keys.ts](saivage/src/agents/prompt-keys.ts) | add the system prompt                                |
| [src/agents/tool-filters.ts](saivage/src/agents/tool-filters.ts) | add the Librarian's whitelist                                  |
| [src/agents/conventions.ts](saivage/src/agents/conventions.ts) | add the Librarian's runtime conventions fragment                  |
| [src/knowledge/permissions.ts](saivage/src/knowledge/permissions.ts) | add `librarian` to the role enum and its permission row    |
| [src/knowledge/types.ts](saivage/src/knowledge/types.ts) | add `"librarian"` to `KnowledgeAgentRoleSchema`                          |
| `src/agents/librarian.ts` (new)                     | agent class extending `BaseAgent` (matching the shape of the existing planner/researcher classes) |
| [src/runtime/dispatcher.ts](saivage/src/runtime/dispatcher.ts) | NO change in the focused proposal; one new branch in the level-up    |
| [src/runtime/supervisor.ts](saivage/src/runtime/supervisor.ts) | enqueue incident handoffs to the Librarian                          |
| `src/runtime/rag-incident-logger.ts` (new)          | minimal helper that turns runtime RAG warnings into supervisor handoffs       |
| `src/agents/librarian.test.ts` (new)                | unit + integration tests                                                     |
| `SPEC/v2/rag/librarian.md` (new)                    | documentation                                                                |

## 11. Boot, runtime, and lifecycle

- At runtime boot, the Librarian is registered like every other
  agent (no special path).
- It has no warm-up work; the first turn happens on the first
  inbound handoff or operator request.
- It does NOT participate in the eager-knowledge boot loop for other
  agents (it is one consumer of the same eagerly-loaded skills and
  memories).
- The first time the project has zero registered RAG datasets (other
  than `skills`/`memories`), the operator either explicitly asks
  the Librarian to index something, or the planner does on first
  task. There is no auto-creation of collections.

## 12. Testing

- Unit tests for the Librarian's prompt outputs (golden-fixture
  test that asserts the prompt contains the bounded-role statement,
  the decision tree, and the journaling policy).
- Integration test that simulates a planner → librarian handoff
  with a query for which no collection exists yet; assert the
  Librarian calls `rag.list`, then `rag.register`, then `rag.ingest`,
  then writes a memory, then hands back. The integration test mocks
  the RAG manager with a fake that records calls.
- A failure-injection test that returns `EMBEDDING_DRIFT` from
  `rag.query`; assert the Librarian invokes the drop+register+ingest
  recovery sequence.

## 13. Non-goals

- A scheduler. Recurrence is the planner's job; the Librarian asks
  the planner to schedule.
- A separate Librarian process. The agent runs in the same fastify
  process as every other agent.
- A web-UI surface. Operator interactions go through the chat agent.
- A "knowledge graph" of collections. The registry plus the
  project-memory journal is enough.
- Cross-project federation. One project, one set of collections.
