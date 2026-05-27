# F03 — Librarian Agent: Functional Analysis

This analysis introduces a single bounded **Librarian** agent that
curates unprotected RAG collections. It returns reports to its caller
and never mutates plan state, source files, or protected
skill/memory collections.

## 1. Verified Facts

### 1.1 Dispatch

Dispatch tools are roster-keyed but the JSON schemas are explicit:

- [src/agents/roster.ts](src/agents/roster.ts#L352) declares each
  role's `dispatchTool` and `dispatchableBy`.
- [src/agents/base.ts](src/agents/base.ts#L1121-L1137) maintains
  `DISPATCH_SCHEMA_BY_TOOL` keyed by tool name; roster entries are
  validated against it at module load.
- [src/server/bootstrap.ts](src/server/bootstrap.ts#L336) instantiates
  the concrete agent class via `switch (role)`.

Adding a non-worker `librarian` role requires:

1. `RUN_LIBRARIAN_SCHEMA` constant + entry in `DISPATCH_SCHEMA_BY_TOOL`.
2. `case "librarian"` in the bootstrap switch.
3. `src/agents/librarian.ts` implementing `LibrarianAgent`.

[src/agents/handoff.ts](src/agents/handoff.ts) just builds a shared
free-text context; there is no `Handoff` envelope.
[src/runtime/supervisor.ts](src/runtime/supervisor.ts) only inspects
logs and cancels stuck agents — no incident queue.
[src/agents/conventions.ts](src/agents/conventions.ts) is a static
write-territory check, not runtime prompt injection.

### 1.2 Prompts

[src/agents/prompts.ts](src/agents/prompts.ts#L19-L46) loads
`prompts/<key>.md` and maps `RolePromptName` (in
[src/agents/prompt-keys.ts](src/agents/prompt-keys.ts)) via
`PROMPT_KEY_TO_ROLE` and `ROLE_PROMPT_NAMES`.

### 1.3 Tool filtering

[applyToolFilter](src/agents/tool-filters.ts#L31-L44) is name-only,
keyed on `ToolFilterKind`. F03 adds `"librarian"` to the union and a
matching allow-list predicate.

### 1.4 Knowledge ACL — current shape and limits

[src/knowledge/permissions.ts](src/knowledge/permissions.ts#L29) types
`AccessCell` as `"Y" | "Y†" | "-"`. `canCall` gates `(role, op, kind)`
([src/knowledge/permissions.ts](src/knowledge/permissions.ts#L242)).
The dagger marker `Y†` triggers a worker scope check in `checkScope`
([src/knowledge/permissions.ts](src/knowledge/permissions.ts#L260))
that constrains writes to the worker's current stage. The matrix
**does not** key on memory `topic` or on scope dimensions beyond the
worker dagger.

[src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts) currently
performs the ACL `canCall`/`checkScope` checks and does not enforce
topic restrictions in any role.

F03 therefore implements two cooperating enforcements:

1. **A new permissions row** for `librarian` that uses the `Y†` marker
   with a `librarian`-specific `checkScope` extension restricting
   `librarian` writes to `scope === "project"` only.
2. **A handler-side topic guard** in
   [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts) that runs
   only when `ctx.role === "librarian"` on `create_memory` /
   `update_memory`: rejects unless `topic.domain === "rag"` and
   `topic.subject ∈ {"policy", "secret-incidents", "drift-incidents"}`.
   The envelope is `{ error: { code: "KNOWLEDGE_PERMISSION_DENIED",
   message: "librarian writes restricted to topic.domain=rag" } }`.

These two together close the gap that the matrix alone leaves open.

### 1.5 Concrete tool names

- File reads: `read_file`, `list_dir`, `search_files`.
- Skill reads: `list_skills`, `read_skill`, `search_skills`.
- Memory reads: `list_memories`, `get_memory`, `search_memories`.
- Memory writes (Librarian-scope only): `create_memory`,
  `update_memory`.
- RAG (F02): `rag_list`, `rag_stats`, `rag_query`, `rag_register`,
  `rag_ingest`, `rag_drop`, `rag_admin`.

There is no `propose_stage`, no `read_skill_by_id`, no `stat_file`,
no `create_note` in the Librarian whitelist. Chat's `create_note`
routes to Planner; granting it to the Librarian would create a second
planning influence channel inconsistent with the architecture.

### 1.6 `IngestReport` and secret-affected paths

[IngestReport](src/rag/types.ts#L150-L156) exposes only aggregate
counters (`filesScanned`, `filesChanged`, `chunksUpserted`,
`chunksDeleted`, `chunksDroppedSecrets`, `tokensEmbedded`,
`embeddingMs`, `storeMs`). The Librarian cannot observe which paths
held secrets. F03 therefore restricts secret-incident memory writes to:

- `collection_id` of the affected dataset.
- `chunksDroppedSecrets` count.
- Caller-supplied free-text `context` (operator may quote log lines).
- The `lastIngestAt` timestamp from `rag_stats`.

The Librarian never claims to know which files held secrets unless
the operator explicitly provides that information via dispatch
`context`. **FUP-INGEST-PATHS** records the request for F02 to expose
a secret-safe path summary in a future iteration; out of F03 scope.

## 2. Responsibilities

The Librarian's bounded decisions:

1. **Registration design.** Choose `chunker`, `sources`, `watch`,
   `persist` for a new unprotected collection; call `rag_register`.
   Refuse `source ∈ {skill, memory}` upfront and relay the F02
   `RAG_INVALID_ARGS` envelope (F02 §3.3 — protected source rejection
   happens at Zod validation).
2. **Source curation.** Choose `sources[0]` root + include + exclude.
   F02 constrains `fs` datasets to exactly one source root.
3. **Watcher mode.** Choose `false`, native `true`, or
   `{ usePolling: true }`. Polling for LXC bind-mounts and NFS.
4. **Reconcile.** Run `rag_admin action: "reconcile"` on operator
   demand. Not on a schedule.
5. **Ingest on demand.** Run `rag_ingest` against the dataset's root
   — this is also the deletion convergence path (F02 §1.5/§4.5).
6. **Flood reports.** When the operator surfaces a chokidar flood
   (via dispatch `context`), recommend narrower `sources`, broader
   `exclude`, or polling mode. Optionally call
   `rag_admin watch_disarm`/`watch_arm` after operator confirmation.
7. **Drift / corruption response.** On `RAG_CONFIG_DRIFT`,
   `RAG_EMBEDDING_DRIFT`, `RAG_CORRUPTED_STORE`, diagnose and propose
   a rebuild path (`rag_drop` then `rag_register` then `rag_ingest`).
   Never execute destructive recovery without operator (or
   dispatching Planner) confirmation in the same dispatch reply.
8. **Secret-leak follow-up.** When `rag_ingest` returns
   `chunksDroppedSecrets > 0`, record a project-scope memory with
   topic `{domain:"rag", subject:"secret-incidents", aspect:<collection_id>}`
   carrying counts and any operator-supplied context (see §1.6).
9. **Policy memory upkeep.** Persist registration decisions as
   project-scope memories under topic
   `{domain:"rag", subject:"policy", aspect:<collection_id>}`.

Explicitly out of scope: plan mutation; source-file editing;
`run_command`; skill writes; any supersede/archive/delete; protected
dataset mutation; supervisor incident routing; recurring reconcile.

## 3. Dispatch

### 3.1 Roster entry

```ts
{
  role: "librarian",
  worker: false,
  stageScoped: false,
  dispatchTool: "run_librarian",
  dispatchableBy: ["planner", "manager"],
  toolFilter: "librarian",
  abortPriority: 8,
  selfCheckFrequency: 20,
  convention: {
    writeTerritory: [".saivage/rag/", ".saivage/knowledge/memory/"],
    excludeTerritory: ["src/", "research/", "data/"],
    description: "Librarian curates RAG configuration and writes project-scope rag-policy memories only.",
  },
  defaultModelKey: "orchestrator",
  displayName: "Librarian",
  summary: "Curates unprotected RAG collections — registers, ingests, queries, prunes, and diagnoses drift. Returns reports.",
  workerInit: null,
}
```

`dispatchableBy: ["planner", "manager"]` — Planner authors stage-level
collection work; Manager dispatches Librarian during a stage to answer
a curation question. **Chat is not granted** `run_librarian`:
[prompts/chat.md](prompts/chat.md) routes actionable work through
Planner via `create_note`; adding direct Librarian dispatch would
create a second planning influence channel.

### 3.2 Wiring

- Add `RUN_LIBRARIAN_SCHEMA` to [src/agents/base.ts](src/agents/base.ts)
  (object schema: required `objective: string`, optional
  `collection_id: string`, optional `context: string`); add to
  `DISPATCH_SCHEMA_BY_TOOL`.
- Add `case "librarian"` to [src/server/bootstrap.ts](src/server/bootstrap.ts#L336)
  constructing `LibrarianAgent.create(ctx, input, { onActivity,
  onCompactionUpdate })` (mirrors the `inspector` case shape; non-worker,
  non-stage-scoped).
- New `src/agents/librarian.ts` extending `BaseAgent` with a
  `LibrarianInput` matching the schema.

### 3.3 Alternative dispatch paths considered

- **Supervisor incident routing.** Supervisor has no queue and no
  destination-role API. Adding one is new runtime code disallowed by
  the topic.
- **Dispatcher auto-routing on retrieval intent.** Surface-string
  heuristics in the dispatcher blur ownership.
- **Chat direct dispatch.** Rejected; see §3.1.

### 3.4 Retrieval-miss fallback path for non-Planner / non-Manager agents

When a worker (`coder`, `researcher`, `data_agent`, `designer`,
`critic`, `reviewer`) needs RAG curation but cannot dispatch
`run_librarian`:

1. The worker calls `rag_list` / `rag_stats` / `rag_query` itself
   (these are reachable through the read-only filter; F02 §3.1).
2. If retrieval misses or the worker needs registration / ingest /
   admin work, it records the gap in its existing task report
   (`TaskReport.notes` field used by every worker today) and surfaces
   it to its parent Manager.
3. Manager dispatches `run_librarian` with the worker's findings in
   `context`.
4. Operator-driven requests reach the Librarian via Chat →
   `create_note` → Planner → `run_librarian`.

This preserves Planner ownership and prevents non-Planner roles from
spawning Librarian work autonomously.

## 4. Tool Whitelist

Add `"librarian"` to `ToolFilterKind`. The set:

```ts
const LIBRARIAN_TOOLS = new Set<string>([
  // RAG (F02), all seven
  "rag_list", "rag_stats", "rag_query",
  "rag_register", "rag_ingest", "rag_drop", "rag_admin",
  // File reads
  "read_file", "list_dir", "search_files",
  // Knowledge reads
  "list_skills", "read_skill", "search_skills",
  "list_memories", "get_memory", "search_memories",
  // Memory writes — only create/update; ACL/topic guard restricts
  "create_memory", "update_memory",
  // Stash
  "read_stash",
]);

TOOL_FILTERS.librarian = (name) => LIBRARIAN_TOOLS.has(name);
```

Explicit denies: `create_note`, `archive_memory`, `delete_memory`,
`supersede_memory`, every `*-skill` write, every `plan_*` tool,
`run_command`, every `run_<role>` dispatch tool, `web_search`,
`fetch_url`, every `write_file` variant.

## 5. Knowledge Schema and ACL Row

Add `"librarian"` to
[KnowledgeAgentRoleSchema](src/knowledge/types.ts#L20-L31).

Permissions row, using the `Y†` mechanism extended for the Librarian
in `checkScope`:

| op                          | cell  |
|-----------------------------|-------|
| `create-memory`             | `Y†`  |
| `update-memory`             | `Y†`  |
| `read-skill`                | `Y`   |
| `read-memory`               | `Y`   |
| `list-skill`                | `Y`   |
| `list-memory`               | `Y`   |
| `search-skill`              | `Y`   |
| `search-memory`             | `Y`   |
| every other op (every kind) | `-`   |

`checkScope` is extended:

```ts
if (cell === "Y†" && role === "librarian") {
  if (scope !== "project") return { ok: false, code: "KNOWLEDGE_SCOPE_DENIED" };
  return { ok: true };
}
// existing worker dagger path
if (cell === "Y†") { /* existing worker stage check */ }
```

The handler-side topic guard in
[src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts) runs after
`canCall`/`checkScope` succeed:

```ts
if (ctx.role === "librarian" && (op === "create" || op === "update")) {
  if (record.topic?.domain !== "rag") return permissionDenied("topic.domain must be rag");
  const allowed = new Set(["policy", "secret-incidents", "drift-incidents"]);
  if (!allowed.has(record.topic?.subject ?? "")) return permissionDenied("topic.subject not allowed");
}
```

For `update_memory`, the existing handler reads the prior record and
applies the patch; the guard runs on the resulting merged record so a
patch cannot escape the topic restriction.

Memory record shape for Librarian writes:

```ts
{
  scope: "project",
  topic: { domain: "rag", subject: <"policy"|"secret-incidents"|"drift-incidents">, aspect: <collection_id> },
  target_agents: ["librarian"],
  survive_compaction: true,
  body: "<markdown report>",
}
```

`target_agents: ["librarian"]` keeps the Librarian's bookkeeping out
of every other agent's eager-loaded context.

## 6. Operator Conflict Handling

When the operator manually edits `<projectRoot>/.saivage/saivage.json`
mid-process, F02 mutating calls surface `RAG_CONFIG_DRIFT` on the
next mutation. The Librarian:

- Does **not** read `.saivage/saivage.json` directly (sensitive
  provider fields).
- Treats `rag_list` + `rag_stats` as the **live manager view**.
- Treats the dispatch input `context` as the operator's stated intent.
- Compares the two and reports divergence.
- Recommends operator restart for large divergence, or
  `rag_register persist:true` over the drifted dataset to re-sync the
  disk config to the live state.
- Updates `policy` memory only after the operator confirms which side
  wins; never silently overwrites prior policy.

## 7. Prompt Outline (`prompts/librarian.md`)

1. **Role boundary.** "You curate unprotected RAG collections only.
   You never edit source files, plan stages, or run shell commands.
   You return a markdown report; the caller decides what to act on."
2. **Tool inventory** (§4) and short purpose of each. Protected
   collections are read-only via `rag_query`; knowledge writes are
   limited to project-scope `topic.domain=rag` memories.
3. **Discovery.** Always start with `rag_list`. For an existing
   collection, `rag_stats`. Cross-reference policy memories via
   `search_memories` with `topic.domain=rag`.
4. **Registration decision tree.** Chunker picker (`markdown` for
   `.md|.mdx|.rst|.txt`; `code` for source trees). Watcher picker
   (`false` for one-shot ingests, native `true` for reliable FS,
   `{usePolling:true}` for bind-mounts/NFS; default polling 2000 ms).
   `persist:true` is the default unless the operator asks for an
   ephemeral session-only collection.
5. **Destructive-action confirmation.** Before any `rag_drop` or
   rebuild on a non-empty dataset, restate the consequence in the
   reply and require the caller to re-dispatch with `objective:
   "confirmed: <previous objective>"`. Never recover silently.
6. **No-hit handling.** If `rag_query` returns `hits: []`, say so,
   suggest broadening filters, and if `lastIngestAt` is stale,
   recommend `rag_ingest`. Do not invent answers.
7. **Per-error response.** §8 table.
8. **Secret-safe reporting.** §1.6 limit: counts + collection_id +
   operator-supplied context only; **never the dropped content** and
   **never invented path lists**.
9. **Operator conflict.** Honour §6.
10. **Response shape.** Markdown reply with sections `Findings`,
    `Actions taken`, `Recommendations`, `Open questions`. No
    `create_note`, no plan-stage proposals.

## 8. Per-Error Decision Tree

| Trigger                                  | Librarian response                                                                                                  |
|------------------------------------------|----------------------------------------------------------------------------------------------------------------------|
| `RAG_DISABLED`                            | Refuse; recommend operator enable `config.rag.enabled` and re-dispatch.                                              |
| `RAG_INVALID_ARGS`                        | Report which field failed validation (including `source: skill|memory` rejection); do not retry.                     |
| `RAG_DATASET_NOT_FOUND`                   | Run `rag_list`; suggest correct id or propose `rag_register`.                                                        |
| `RAG_PROTECTED_DATASET`                   | Redirect caller to `search_skills` / `search_memories`. No retry.                                                    |
| `RAG_BLOCKED_PATH`                        | Report the blocked path; suggest a permitted root inside the project.                                                |
| `RAG_INVALID_QUERY_FILTER`                | Restate supported filter shape; retry once with corrected filter; otherwise report and stop.                         |
| `RAG_CONFIG_DRIFT`                        | Diagnose live vs. stated intent; require operator confirmation before any `rag_drop`. See §6.                        |
| `RAG_EMBEDDING_DRIFT`                     | Same as drift; never auto-recover.                                                                                    |
| `RAG_CORRUPTED_STORE`                     | Quote the named path; propose rebuild with explicit confirmation gate.                                               |
| `RAG_PROVIDER_UNAVAILABLE`                | Recommend checking provider credentials; do not retry within the dispatch.                                            |
| `RAG_INGEST_LOCKED`                       | Advise concurrent ingest in flight; do not loop; one retry only if caller insists.                                   |
| `RAG_WATCH_DISABLED`                      | Recommend updating `watch` via `rag_register` (with `persist:true`).                                                  |
| `RAG_PERSIST_FAILED`                      | Report partial failure with `details.rollback` value; recommend operator action.                                     |
| `RAG_CONTROL_BUSY`                        | Wait and retry once; if still busy, return the failure to the caller.                                                |
| `RAG_INTERNAL`                            | Quote the message; recommend operator inspect the log; do not retry.                                                 |
| `RAG_SECRET_DROPPED` (reserved)           | Treat identically to `chunksDroppedSecrets > 0`. F02 currently does not emit this code; the row exists for forward compatibility. |
| `chunksDroppedSecrets > 0` on `rag_ingest`| Write a `secret-incidents` memory (count + collection_id + caller `context` only; never invented paths).             |
| Chokidar flood report (operator-supplied) | Recommend narrower roots, broader `exclude`, or `{usePolling:true}`. Draft a `rag_register persist:true` call.        |
| Caller asks for a recurring reconcile     | Refuse; explain no scheduler; recommend a Planner stage that calls `rag_admin reconcile`.                            |
| Caller asks Librarian to propose a stage  | Refuse; place the recommendation in the final report's `Recommendations`.                                            |

## 9. Files

| File                                                                                | Action  |
|--------------------------------------------------------------------------------------|---------|
| `prompts/librarian.md` (new)                                                        | Create  |
| [src/agents/prompt-keys.ts](src/agents/prompt-keys.ts)                              | Add `"librarian"`. |
| [src/agents/prompts.ts](src/agents/prompts.ts)                                      | `PROMPT_KEY_TO_ROLE.librarian = "librarian"`; add to `ROLE_PROMPT_NAMES`. |
| [src/agents/roster.ts](src/agents/roster.ts)                                        | Add ROSTER entry; add `"librarian"` to `ToolFilterKind`. |
| [src/agents/tool-filters.ts](src/agents/tool-filters.ts)                            | Define `LIBRARIAN_TOOLS` and `TOOL_FILTERS.librarian`. |
| [src/agents/base.ts](src/agents/base.ts#L1121)                                      | Add `RUN_LIBRARIAN_SCHEMA`; add to `DISPATCH_SCHEMA_BY_TOOL`. |
| [src/server/bootstrap.ts](src/server/bootstrap.ts#L336)                             | Add `case "librarian"`. |
| `src/agents/librarian.ts` (new)                                                     | `LibrarianAgent` class + `LibrarianInput` interface. |
| [src/knowledge/types.ts](src/knowledge/types.ts#L20)                                | Add `"librarian"` to `KnowledgeAgentRoleSchema`. |
| [src/knowledge/permissions.ts](src/knowledge/permissions.ts)                        | Add the §5 row; extend `checkScope` for the Librarian dagger. |
| [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts)                            | Add topic guard for `ctx.role === "librarian"` on `create_memory` / `update_memory`. |
| `src/agents/librarian.test.ts` (new)                                                | Roster entry, filter membership including denies, prompt round-trip, knowledge ACL row coverage. |
| `src/agents/librarian.dispatch.test.ts` (new)                                       | Planner and Manager can dispatch `run_librarian`; Chat cannot; child-spawner constructs `LibrarianAgent`. |
| `src/agents/librarian.behaviour.test.ts` (new)                                      | Representative decision-tree branches with mocked F02 tools (`RAG_CONFIG_DRIFT` confirmation gate; `chunksDroppedSecrets > 0` memory write; protected-dataset redirect; no-hit fallback). |
| `src/knowledge/permissions.test.ts`                                                 | Cover Librarian dagger / non-project deny / topic guard. |
| `src/mcp/knowledgeMemory.test.ts`                                                   | Cover topic-guard rejection paths for `create_memory` and `update_memory` (including the patch-merge case). |
| `SPEC/v2/rag/librarian.md` (new)                                                    | Operator-facing contract. |

## 10. Non-Goals

- No new runtime mechanism in [src/runtime/](src/runtime/).
- No supervisor incident routing.
- No dispatcher auto-routing.
- No plan-stage proposal tool, no `create_note` grant.
- No scheduler.
- No source-file mutation.
- No write access to protected `skill`/`memory` collections.
- No knowledge writes outside project-scope `topic.domain="rag"`
  memories.
