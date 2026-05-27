# F03 — Librarian Agent: Functional Analysis

This analysis introduces a single bounded **Librarian** agent dedicated
to curating RAG collections. The Librarian uses existing roster /
prompt / tool-filter / dispatcher seams; no new runtime mechanism is
introduced. It returns reports to its caller and never mutates plan
state or user source files.

## 1. Verified Agent Framework Facts

### 1.1 Dispatch architecture

There is **no** `Handoff` envelope module in this codebase.
[src/agents/handoff.ts](src/agents/handoff.ts) builds a shared
free-text context block for a follow-up assignment; it does not switch
the executing role and is not a queue.

The actual dispatch seam is:

- [src/agents/roster.ts](src/agents/roster.ts) — each role declares
  `dispatchTool` and `dispatchableBy`. The dispatch tool name is the
  agent's only entry point from another agent. Roles with
  `dispatchTool === null` cannot be invoked by other agents.
- The dispatch tools are synthesised by `BaseAgent`; the dispatcher
  in [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts) handles
  tool invocations, spawning the child worker.
- The bootstrap child-spawner reads the roster to decide which class
  to instantiate.

### 1.2 Supervisor and conventions

[src/runtime/supervisor.ts](src/runtime/supervisor.ts) only inspects
logs and cancels stuck abortable agents. It has no incident queue and
no destination-role routing API.

[src/agents/conventions.ts](src/agents/conventions.ts) holds the
write-territory rules used by `checkConvention` to warn workers
straying outside their writable areas. It is **not** a runtime
prompt/context injection mechanism. There is no existing "inject
recent rag-policy memories into every turn" hook.

### 1.3 Tool filtering

[applyToolFilter](src/agents/tool-filters.ts#L31-L44) is keyed on
`ToolFilterKind` (one of `planner`, `worker`, `reviewer`, `inspector`,
`chat`) and inspects only `tool.name`. There are no wildcard sets;
extending the role family means adding a new `ToolFilterKind` union
member and a matching predicate in the `TOOL_FILTERS` record.

### 1.4 Prompts

[src/agents/prompts.ts](src/agents/prompts.ts#L19-L46) loads
`prompts/<key>.md` and maps `RolePromptName` (declared in
[src/agents/prompt-keys.ts](src/agents/prompt-keys.ts)) to `AgentRole`
via `PROMPT_KEY_TO_ROLE`. Adding a Librarian prompt requires:

1. A new `prompts/librarian.md` file.
2. Adding `"librarian"` to `RolePromptName` in
   [src/agents/prompt-keys.ts](src/agents/prompt-keys.ts).
3. Adding `librarian: "librarian"` to `PROMPT_KEY_TO_ROLE` and
   `"librarian"` to `ROLE_PROMPT_NAMES`.

### 1.5 Knowledge schema

[KnowledgeAgentRoleSchema](src/knowledge/types.ts#L20-L31) enumerates
ten roles independently from `AgentRole`. Adding the Librarian to
knowledge writes/reads requires extending the schema and adding a
permission row in
[src/knowledge/permissions.ts](src/knowledge/permissions.ts).

### 1.6 Concrete tool names (verified)

- File tools: `read_file`, `list_dir`, `search_files`. There is **no
  `stat_file`**.
- Skill tools: `read_skill`, `list_skills`, `search_skills`,
  `create_skill`, `update_skill`, `supersede_skill`, `archive_skill`,
  `delete_skill`. There is **no `read_skill_by_id`**.
- Memory tools: `get_memory`, `list_memories`, `search_memories`,
  `create_memory`, `update_memory`, `supersede_memory`,
  `archive_memory`, `delete_memory`.
- Plan tools (denied to the Librarian): `plan_get`,
  `plan_get_current_stage`, `plan_add_stage`, etc. There is **no
  `propose_stage`** tool.
- RAG tools (provided by F02): `rag_list`, `rag_stats`, `rag_query`,
  `rag_add`, `rag_ingest`, `rag_register`, `rag_drop`, `rag_admin`.

## 2. Responsibilities

The Librarian owns a bounded set of decisions:

1. **Collection registration.** Decide when a new RAG collection is
   warranted (`rag_register` with `persist: true`), what `source`,
   `chunker`, and `sources` it gets. Forbidden from registering
   collections with `source: "skill" | "memory"` — those are owned by
   F01.
2. **Source curation.** Decide which `sources` (roots / include /
   exclude globs) feed each unprotected collection.
3. **Watcher mode.** Decide `watch: false | true | { usePolling: true, interval? }`.
   Polling for LXC bind-mounts and NFS where native events are
   unreliable.
4. **Reconcile.** Run `rag_admin action: "reconcile"` on demand
   (operator request, suspected drift, after manual edits). **Not on
   a schedule** — there is no scheduler.
5. **Pruning.** `rag_admin action: "delete_record"` to remove a
   single record at a stable `path` when a caller reports a known-bad
   document.
6. **Flood reports.** When a chokidar flood event is logged, advise
   the operator (or Planner, if dispatched by Planner) to reduce the
   source root scope, adjust `exclude` patterns, or switch to
   polling. **Does not** auto-disarm and re-arm watchers without
   confirmation.
7. **Drift / corruption response.** On `RAG_CONFIG_DRIFT`,
   `RAG_EMBEDDING_DRIFT`, or `RAG_CORRUPTED_STORE` surfaced by the F02
   tools, the Librarian produces a diagnosis report and proposes a
   recovery option (rebuild via `rag_drop` + `rag_register` +
   `rag_ingest`). Does **not** execute the destructive recovery without
   the operator's or Planner's explicit confirmation in the same
   conversation.
8. **Secret-leak follow-up.** When `rag_add` returns
   `RAG_SECRET_DROPPED` or a bulk ingest returns
   `chunksDroppedSecrets > 0`, the Librarian records the incident in
   a project-scope memory under `topic.domain = "rag"`,
   `topic.subject = "secret-incidents"`, and lists the affected paths
   for the operator. Does not redact source files.

The Librarian explicitly does **not** own:

- Plan mutation. No plan write tool is granted.
- Source file editing. No `write_file` or coder tools.
- Subprocess execution. No `run_command` tool.
- Skill or memory record CRUD on the protected datasets — F01 tools
  own those.

## 3. Dispatch

### 3.1 Decision

The Librarian is **dispatchable** by `planner`, `manager`, and
`chat` (chat handoff is necessary so an operator can ask "what does
the docs collection say about X" without intermediate planning).

Roster entry:

```ts
{
  role: "librarian",
  worker: false,
  stageScoped: false,
  dispatchTool: "run_librarian",
  dispatchableBy: ["planner", "manager", "chat"],
  toolFilter: "librarian",
  abortPriority: 8,
  selfCheckFrequency: 20,
  convention: { writeTerritory: [".saivage/rag/"], excludeTerritory: ["src/", "research/", "data/"], description: "Librarian only edits RAG configuration via tools; no source files" },
  defaultModelKey: "orchestrator",
  displayName: "Librarian",
  summary: "Curates RAG collections — registers, ingests, queries, prunes, and diagnoses drift. Returns reports; never edits source files or plan state.",
  workerInit: null,
}
```

`worker: false` because the Librarian is not a stage-scoped worker;
it answers cross-cutting collection requests.

### 3.2 The three paths compared

- **Explicit dispatch via `run_librarian`** — covered by the roster
  entry. This is the primary path.
- **Supervisor incident routing** — rejected. The supervisor today
  has no queue and no destination-role dispatch. Adding it would be
  new runtime code that the topic disallows under "no over-engineering
  / no Librarian state machine".
- **Dispatcher auto-routing on retrieval-like phrasing** — rejected.
  String-intent heuristics in the dispatcher blur ownership and
  surprise users when an agent silently switches roles. A retrieval
  failure should be returned to the caller; the caller decides to
  dispatch the Librarian explicitly.

Operator chat reaches the Librarian via the `chat` role's
`run_librarian` dispatch. The Chat agent has read-only access to RAG
and may delegate write/admin requests to the Librarian.

## 4. Tool Whitelist

A new `ToolFilterKind` value `"librarian"` is added to
[src/agents/roster.ts](src/agents/roster.ts) and a matching predicate
to [src/agents/tool-filters.ts](src/agents/tool-filters.ts):

```ts
const LIBRARIAN_TOOLS = new Set<string>([
  // RAG (F02)
  "rag_list", "rag_stats", "rag_query",
  "rag_add", "rag_ingest", "rag_register", "rag_drop", "rag_admin",
  // File reads (no writes, no run_command)
  "read_file", "list_dir", "search_files",
  // Knowledge reads (no writes — Librarian's writes go via memory create only)
  "list_skills", "read_skill", "search_skills",
  "list_memories", "get_memory", "search_memories",
  // Memory writes restricted to project scope incident logs
  "create_memory", "update_memory",
  // Notes for the operator
  "create_note",
  // Read-stash for handoff context
  "read_stash",
]);

TOOL_FILTERS.librarian = (n) => LIBRARIAN_TOOLS.has(n);
```

Explicitly **not** granted: `archive_memory`, `delete_memory`,
`supersede_memory`, `create_skill`, `update_skill`,
`supersede_skill`, `archive_skill`, `delete_skill`, plan tools,
`run_command`, `run_*` worker dispatch tools, `web_search`,
`fetch_url`.

## 5. Prompt and Wiring

A new file `prompts/librarian.md` is added. The prompt outline
covers, in order:

1. **Role boundary.** "You curate RAG collections only. You never edit
   source files, plan stages, or run shell commands. You return a
   report; the caller acts on it."
2. **Collection discovery.** Begin every task with `rag_list` and, if
   the goal touches a specific collection, `rag_stats`. Cross-reference
   policy memories via `search_memories` with `topic.domain = "rag"`.
3. **Registration decision tree.** When to choose `chunker: markdown`
   vs. `code` vs. `memory`. Watcher mode picker: `false` for record-
   driven content, `true` for native FS where chokidar reliably
   delivers events, `{ usePolling: true }` for LXC bind-mounts and
   NFS. `persist: true` for any registration intended to outlast the
   session.
4. **Destructive action confirmation.** Before any `rag_drop`,
   `rag_admin action: "delete_record"`, or `rag_admin action: "reconcile"`
   on a non-empty dataset, restate the consequence and require the
   caller's confirmation in the next turn. Never recover from drift
   silently.
5. **Secret-safe reporting.** Never include the dropped chunk content
   from `chunksDroppedSecrets` in the response or memory body — only
   the count and path summary.
6. **Collection summary wording.** A single-sentence summary per
   collection in `rag_list` results: id, source kind, chunk count,
   protected status, last ingest timestamp.
7. **Failure handling.** Per error code (next table), the Librarian's
   response. On `RAG_DISABLED`, refuse and return an explanation. On
   `RAG_INVALID_QUERY_FILTER`, restate the supported filter form and
   retry once. On `RAG_PROTECTED_DATASET`, route the caller to F01's
   `search_skills`/`search_memories`. On `RAG_INGEST_LOCKED`, advise
   the caller to retry; do not loop.
8. **No-hit retrieval fallback.** When `rag_query` returns `hits: []`,
   the Librarian's report says so and suggests broadening filters or
   re-running ingest if `lastIngestAt` is stale; it does not invent
   answers.
9. **Final response shape.** Markdown report with sections:
   `Findings`, `Actions taken`, `Recommendations`, `Open questions`.
   The caller (Planner/Manager/Chat) decides whether to schedule
   follow-up stages or surface to the user.

## 6. Decision Tree by Error / Event

| Trigger                                  | Librarian response                                                                                                  |
|------------------------------------------|----------------------------------------------------------------------------------------------------------------------|
| `RAG_DISABLED`                            | Refuse the task; recommend operator enable `config.rag.enabled` and re-dispatch.                                    |
| `RAG_DATASET_NOT_FOUND`                   | Run `rag_list`; suggest correct id or propose `rag_register` if registration is the missing step.                   |
| `RAG_PROTECTED_DATASET`                   | Redirect caller to `search_skills` / `search_memories`. No retry.                                                    |
| `RAG_INVALID_QUERY_FILTER`                | Restate the supported filter shape; retry once with the corrected filter.                                            |
| `RAG_INVALID_ARGS`                        | Report which field failed schema validation; do not retry.                                                           |
| `RAG_BLOCKED_PATH`                        | Report the blocked path; suggest a permitted root inside the project.                                                |
| `RAG_INGEST_LOCKED`                       | Advise the caller a concurrent ingest is in flight; do not loop. One single retry after 30s if explicitly asked.    |
| `RAG_CONFIG_DRIFT`                        | Diagnose: report previous vs. current. Propose destructive rebuild as a recommendation; require operator/Planner confirmation in the next turn before any `rag_drop`. |
| `RAG_EMBEDDING_DRIFT`                     | Same as drift; never auto-recover.                                                                                    |
| `RAG_CORRUPTED_STORE`                     | Recommend operator inspect the named path; propose rebuild path with explicit confirmation gate.                     |
| `RAG_PROVIDER_UNAVAILABLE`                | Recommend checking provider credentials; do not retry.                                                               |
| `RAG_WATCH_DISABLED`                      | Recommend updating `watch` in the registered config; explain `persist: true` requirement.                            |
| `RAG_WATCHER_UNAVAILABLE`                 | Recommend `{ usePolling: true }` and narrower roots; quote `WatcherUnavailableError` message verbatim.               |
| `RAG_SECRET_DROPPED` on `rag_add`         | Log a project-scope `rag/secret-incidents` memory recording the path and reason; tell caller their text was rejected.|
| `chunksDroppedSecrets > 0` on `rag_ingest`| Same memory, listing the affected paths summary; recommend the operator audit those files.                          |
| `RAG_PERSIST_FAILED`                      | Report partial success: runtime registered, persistence failed; recommend the operator re-run after resolving config IO.|
| Chokidar flood report (from operator log) | Recommend reducing source roots, adjusting `exclude`, or switching to polling. Provide a draft `rag_register` call; do not execute. |
| Manual `saivage.json` edit by operator    | When invoked to "reconcile after manual edit", read current `config.rag.datasets` via the operator's report; surface drift via `rag_list` cross-check; recommend operator confirm the intended config; do not silently re-register. |
| Caller asks for a recurring reconcile     | Refuse; explain the system has no scheduler and recurring work belongs in Planner's stages.                          |
| Caller asks Librarian to propose a stage  | Refuse; produce the recommendation in the final report instead. Planner decides.                                     |

## 7. Memory Integration

The Librarian persists project-scope memories under
`topic.domain = "rag"`, with subjects:

- `"policy"` — collection-design decisions (chunker, watcher, source globs).
- `"secret-incidents"` — bulk-drop summaries (counts + paths, never content).
- `"drift-incidents"` — drift diagnoses awaiting operator action.

Permission row in
[src/knowledge/permissions.ts](src/knowledge/permissions.ts):
`librarian` cell = `"Y"` for `create-memory`, `update-memory`,
`read-*`, `list-*`, `search-*` on both skill and memory kinds.
`"-"` for `supersede`, `archive`, `delete`, and for any
`*-skill` create/update.

`KnowledgeAgentRoleSchema` extended to include `"librarian"`.

## 8. Operator Conflict

When the operator manually edits `saivage.json` to change a
collection's config while the Librarian holds opinions about that
collection in `rag-policy` memory, the resolution is:

1. The operator's edit is authoritative on disk.
2. F02's tools surface drift via `RAG_CONFIG_DRIFT` when the
   manager's view diverges from the registry stamp.
3. The Librarian reads the current `config.rag.datasets` via
   `rag_list` + `rag_stats` (which expose the live manager view), and
   updates its policy memory to reflect the operator's chosen state,
   noting in the body that the policy was revised due to an operator
   edit. It does not re-register or fight the change.

## 9. Files

| File                                                                                    | Action  |
|------------------------------------------------------------------------------------------|---------|
| `prompts/librarian.md` (new)                                                            | Create  |
| [src/agents/prompt-keys.ts](src/agents/prompt-keys.ts)                                  | Edit — add `"librarian"`. |
| [src/agents/prompts.ts](src/agents/prompts.ts)                                          | Edit — add map entries. |
| [src/agents/roster.ts](src/agents/roster.ts)                                            | Edit — add `librarian` entry; add `"librarian"` to `ToolFilterKind`. |
| [src/agents/tool-filters.ts](src/agents/tool-filters.ts)                                | Edit — add `LIBRARIAN_TOOLS` and predicate. |
| [src/knowledge/types.ts](src/knowledge/types.ts)                                        | Edit — add `"librarian"` to `KnowledgeAgentRoleSchema`. |
| [src/knowledge/permissions.ts](src/knowledge/permissions.ts)                            | Edit — add `librarian` matrix row. |
| `src/agents/librarian.test.ts` (new)                                                    | Create — roster entry, filter membership, prompt round-trip. |
| `src/agents/librarian.integration.test.ts` (new)                                        | Create — dispatch from Planner; mocked F02 tools; verify decision tree on a representative error. |
| `SPEC/v2/rag/librarian.md` (new)                                                        | Create — operator-facing contract.       |

## 10. Non-Goals

- No new runtime code in [src/runtime/](src/runtime/).
- No supervisor incident routing.
- No dispatcher auto-routing.
- No plan-stage proposal tool.
- No scheduler or recurring jobs.
- No source-file mutation tools.
- No write access to the protected `skills`/`memory` RAG datasets.
