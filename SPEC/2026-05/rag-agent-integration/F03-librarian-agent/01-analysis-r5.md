# F03 — Librarian Agent: Functional Analysis

This analysis introduces a single bounded **Librarian** agent that
curates unprotected RAG collections. It returns reports to its caller
and never mutates plan state, source files, or protected
skill/memory collections.

## 1. Verified Facts

### 1.1 Dispatch

- [src/agents/roster.ts](src/agents/roster.ts#L30-L63) declares the
  roster shape (worker flags, dispatch metadata, filter, abort
  priority, self-check frequency, `convention: ConventionRule | null`,
  model key, display name, summary, `workerInit`).
- [src/agents/base.ts](src/agents/base.ts#L1001-L1151) maintains
  `DISPATCH_SCHEMA_BY_TOOL` keyed by tool name; roster entries are
  validated at module load.
- [src/server/bootstrap.ts](src/server/bootstrap.ts#L336-L506)
  instantiates concrete agent classes via `switch (role)`. Planner
  and Manager receive child spawners; non-worker roles like
  `inspector` follow a separate construction shape.

Adding a non-worker `librarian` role requires:

1. `RUN_LIBRARIAN_SCHEMA` constant + entry in `DISPATCH_SCHEMA_BY_TOOL`.
2. `case "librarian"` in the bootstrap switch (mirroring the
   `inspector` non-worker construction pattern).
3. `src/agents/librarian.ts` implementing `LibrarianAgent`.

### 1.2 Prompts

[src/agents/prompts.ts](src/agents/prompts.ts#L19-L46) loads
`prompts/<key>.md`; `PROMPT_KEY_TO_ROLE` and `ROLE_PROMPT_NAMES` map
prompt keys to roles. F03 adds `"librarian"` to both.

### 1.3 Tool filtering

[applyToolFilter](src/agents/tool-filters.ts#L31-L44) is name-only
and is a **presentation boundary, not an enforcement boundary**: the
runtime dispatcher resolves tool names from the unfiltered catalog
([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L156-L194)).
F03 therefore relies on F02's handler-layer role check
(`RAG_UNAUTHORIZED_ROLE` for non-admin roles) and the knowledge
handler's `canCall`/`checkScope` calls for enforcement, while still
adding `"librarian"` to `ToolFilterKind` and a matching allow-list
predicate to shape the model-facing schema list.

### 1.4 Knowledge ACL — current shape and limits

[permissions.ts](src/knowledge/permissions.ts#L29-L39):
`AccessCell = "Y" | "Y†" | "-"`.
[canCall](src/knowledge/permissions.ts#L222-L244) gates `(role, op,
kind)`.
[checkScope](src/knowledge/permissions.ts#L246-L292) accepts
`(role, op, kind, scope, scope_ref, ctx)` and applies the dagger
worker-stage path **only** after `cellFor(...) === "Y†"`.
`ScopeCheckResult` returns `code: "UNAUTHORIZED_SCOPE"` on failure
([src/knowledge/permissions.ts](src/knowledge/permissions.ts#L246-L280)).

Handlers convert ACL failures to `KnowledgeStoreError("UNAUTHORIZED_ROLE",
...)` / `KnowledgeStoreError("UNAUTHORIZED_SCOPE", ...)` and the MCP
adapter serialises them as `{ error: { code, message } }`
([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L165-L181),
[src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L297-L301)).
F03 reuses these existing codes; **no new `KNOWLEDGE_PERMISSION_DENIED`
code is introduced**.

Important current behavior gaps F03 must work around:

- `create_memory` calls `gateRole` and `gateScope` before
  `createMemory`
  ([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L193-L215)).
- `update_memory` calls `gateRole(role, "create")` but **does not
  call `gateScope`**
  ([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L216-L228)).
  The current schema does not let `update_memory` patch `scope` or
  `topic` ([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L51-L67)).

F03 implements three cooperating enforcements for the Librarian:

1. **A new permissions row** for `librarian` with `Y†` on
   `create-memory` and `update-memory` only.
2. **`checkScope` extension** with an explicit Librarian branch
   placed **before** the existing worker-stage branch: returns
   `{ ok: false, code: "UNAUTHORIZED_SCOPE", reason: "librarian
   writes restricted to scope=project" }` when `role === "librarian"
   && scope !== "project"`. The error code matches the existing
   union.
3. **Handler-side topic + preflight-scope guard** in
   [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts):

   - For `create_memory` (after the existing `gateRole`/`gateScope`):
     when `role === "librarian"`, validate
     `args.topic.domain === "rag"` and `args.topic.subject ∈
     {"policy","secret-incidents","drift-incidents"}`. On failure:
     `throw new KnowledgeStoreError("UNAUTHORIZED_ROLE",
     "librarian writes restricted to topic.domain=rag")`.
   - For `update_memory`: the current handler does not preflight the
     record. F03 changes the `update_memory` branch to:
     1. Read the existing memory via `getMemory(root, { id })`.
     2. Run `gateScope(role, "create", existing.scope, existing.scope_ref,
        { stageId: ctx.stageId })`. This closes the pre-existing gap
        for *every* role with a `Y†` update cell, not just
        Librarian — an intentional improvement.
     3. When `role === "librarian"`, validate the existing record's
        topic against the same allow-list (the schema disallows
        patching `topic`, so the existing topic is the effective
        topic).
     4. Call `updateMemory(root, ...)` as today.

   The topic-allow-list enforcement is described per-section as the
   "Librarian topic guard" and is a new piece of handler code; it
   uses existing error codes only.

The existing `update_memory` handler accepts no `scope` or `topic`
patch fields ([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L51-L67)),
so preflight-checking the existing record is equivalent to checking
the merged record for the current schema.

### 1.5 Tool name reality and F02 dependency

The seven RAG tool names (`rag_list`, `rag_stats`, `rag_query`,
`rag_register`, `rag_ingest`, `rag_drop`, `rag_admin`) **do not
exist in the current workspace** — built-in services today expose
filesystem, shell, git, web, skills, and memory only
([src/mcp/builtins.ts](src/mcp/builtins.ts#L1912-L1966)). They are
the F02 deliverable.

**F02 is a hard prerequisite for F03.** F03's roster entry, prompt,
whitelist, and decision tree all assume the F02 surface is registered
before F03's roster entry loads. The implementation plan must
sequence F02 → F03.

### 1.6 Non-RAG tool name reality

The non-RAG names in the Librarian whitelist are existing tools:

- Filesystem reads: `read_file`, `list_dir`, `search_files`
  ([src/mcp/builtins.ts](src/mcp/builtins.ts#L401-L442)).
- Skill reads: `list_skills`, `read_skill`, `search_skills`
  ([src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts#L38-L132)).
- Memory reads: `list_memories`, `get_memory`, `search_memories`
  ([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L103-L128)).
- Memory writes: `create_memory`, `update_memory`
  ([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L32-L69)).
- `read_stash` is a BaseAgent synthetic tool
  ([src/agents/base.ts](src/agents/base.ts#L674-L697)).

### 1.7 `IngestReport` shape

[IngestReport](src/rag/types.ts#L150-L159) exposes aggregate counters
only — `filesScanned`, `filesChanged`, `chunksUpserted`,
`chunksDeleted`, `chunksDroppedSecrets`, `tokensEmbedded`,
`embeddingMs`, `storeMs`. No path-level secret-affected information.

The Librarian's secret-incident memory writes therefore include only:

- `collection_id` of the affected dataset.
- `chunksDroppedSecrets` count.
- Caller-supplied free-text `context` (operator log excerpt if any).
- `lastIngestAt` timestamp from `rag_stats`.

**FUP-INGEST-PATHS** records the future request for F02 to expose a
secret-safe path summary.

### 1.8 TaskReport shape

[TaskReportSchema](src/types.ts#L196-L215) has `summary`,
`checklist_results` (with optional per-item `notes`),
`files_changed`, `tests`, `commits`, `issues_found` (`Issue[]`),
truncation/failure flags, and timestamps. There is **no top-level
`notes` field**. Workers escalate retrieval gaps via either:

- a `summary` paragraph at the end,
- a checklist-result `notes` entry, or
- an `Issue` in `issues_found` with `kind: "open_question"` and
  `description: "rag retrieval miss: ..."`.

F03's retrieval-miss fallback (§3.4) uses `issues_found` because it
is the existing escalation channel parsed by the Manager runtime.

## 2. Responsibilities

The Librarian's bounded decisions:

1. **Registration design.** Pick `chunker`, `sources` (one root),
   `watch`, `persist`; call `rag_register`. Refuse `source ∈
   {skill,memory}` upfront and relay the F02 `RAG_INVALID_ARGS`
   envelope (F02 §3.4).
2. **Source curation.** One source root per `fs` dataset (F02
   constraint).
3. **Watcher mode.** `false`, native `true`, or `{ usePolling: true }`.
4. **Reconcile.** On operator demand via `rag_admin reconcile`. Not
   a deletion path.
5. **Ingest on demand.** `rag_ingest` — also the deletion convergence
   path.
6. **Flood reports.** When operator surfaces a chokidar flood,
   recommend narrower roots, broader `exclude`, or polling. May call
   `rag_admin watch_disarm`/`watch_arm` after operator confirmation.
7. **Drift / corruption response.** On `RAG_CONFIG_DRIFT`,
   `RAG_EMBEDDING_DRIFT`, `RAG_CORRUPTED_STORE`: diagnose; propose
   `rag_drop` + `rag_register` + `rag_ingest`. Never execute
   destructive recovery without operator confirmation in the same
   dispatch reply.
8. **Secret-leak follow-up.** When `chunksDroppedSecrets > 0`,
   record a project-scope memory under topic
   `{domain:"rag", subject:"secret-incidents", aspect:<collection_id>}`
   carrying counts + caller-supplied context only (see §1.7).
9. **Policy memory upkeep.** Persist registration decisions as
   project-scope memories under topic
   `{domain:"rag", subject:"policy", aspect:<collection_id>}`.

Out of scope: plan mutation; source-file editing; `run_command`;
skill writes; supersede/archive/delete; protected dataset mutation;
supervisor incident routing; recurring reconcile.

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
    writeTerritory: [".saivage/memory/project/"],
    excludeTerritory: ["src/", "research/", "data/"],
    description: "Librarian writes project-scope rag-policy memories only.",
  },
  defaultModelKey: "orchestrator",
  displayName: "Librarian",
  summary: "Curates unprotected RAG collections — registers, ingests, queries, prunes, and diagnoses drift. Returns reports.",
  workerInit: null,
}
```

`writeTerritory` points at `.saivage/memory/project/`, the actual
on-disk layout for project-scope memories
([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L110-L123)).
Conventions are warnings rather than hard enforcement
([src/agents/conventions.ts](src/agents/conventions.ts#L20-L31)) but
should still describe real territory.

`dispatchableBy: ["planner", "manager"]`. **Chat is not granted**
`run_librarian`: Chat routes actionable work through Planner via
`create_note`.

### 3.2 Wiring

- Add `RUN_LIBRARIAN_SCHEMA` to
  [src/agents/base.ts](src/agents/base.ts#L1001-L1130): required
  `objective: string`, optional `collection_id: string`, optional
  `context: string`. Add to
  [DISPATCH_SCHEMA_BY_TOOL](src/agents/base.ts#L1132-L1151).
- Add `case "librarian"` to
  [src/server/bootstrap.ts](src/server/bootstrap.ts#L336-L396)
  constructing `LibrarianAgent` (mirrors the `inspector` non-worker
  shape).
- New `src/agents/librarian.ts` extending `BaseAgent` with a
  `LibrarianInput` matching the schema.

### 3.3 Alternative dispatch paths considered

- Supervisor incident routing — no queue, no destination-role API
  ([src/runtime/supervisor.ts](src/runtime/supervisor.ts)).
- Dispatcher auto-routing on retrieval intent — surface-string
  heuristics blur ownership.
- Chat direct dispatch — rejected; see §3.1.

### 3.4 Retrieval-miss fallback for non-Planner / non-Manager agents

1. Worker calls `rag_list` / `rag_stats` / `rag_query` itself (these
   are reachable through F02's `READ_ONLY_TOOLS` membership).
2. If retrieval misses or curation work is needed, the worker
   surfaces the gap via `TaskReport.issues_found` with `kind:
   "open_question"` and `description: "rag retrieval miss: ..."`
   ([src/types.ts](src/types.ts#L196-L215)). This is the existing
   channel parsed by Manager runtime
   ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L239-L249)).
3. Manager dispatches `run_librarian` with the worker's findings in
   `context`.
4. Operator-driven requests reach the Librarian via Chat →
   `create_note` → Planner → `run_librarian`.

## 4. Tool Whitelist

Add `"librarian"` to `ToolFilterKind`. The set:

```ts
const LIBRARIAN_TOOLS = new Set<string>([
  "rag_list", "rag_stats", "rag_query",
  "rag_register", "rag_ingest", "rag_drop", "rag_admin",
  "read_file", "list_dir", "search_files",
  "list_skills", "read_skill", "search_skills",
  "list_memories", "get_memory", "search_memories",
  "create_memory", "update_memory",
  "read_stash",
]);

TOOL_FILTERS.librarian = (name) => LIBRARIAN_TOOLS.has(name);
```

Explicit denies: `create_note`, `archive_memory`, `delete_memory`,
`supersede_memory`, every `*-skill` write, every `plan_*` tool,
`run_command`, every `run_<role>` dispatch tool, `web_search`,
`fetch_url`, every `write_file` variant.

Per §1.3 this filter is presentation-only. The Librarian's actual
write authority is enforced by:

- F02's handler `RAG_ADMIN_ROLES.has("librarian")` set by F03 in
  the F03 implementation step.
- The knowledge handler's `gateRole`/`gateScope` plus the
  Librarian topic guard (§1.4 / §5).

## 5. Knowledge Schema and ACL

Add `"librarian"` to
[KnowledgeAgentRoleSchema](src/knowledge/types.ts#L20-L31).

Permissions row using the `Y†` mechanism:

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

`checkScope` extension (added **before** the existing worker-stage
branch):

```ts
// In src/knowledge/permissions.ts checkScope:
if (cellFor(role, op, kind) === "Y†" && role === "librarian") {
  if (scope !== "project") {
    return { ok: false, code: "UNAUTHORIZED_SCOPE",
             reason: "librarian writes restricted to scope=project" };
  }
  return { ok: true };
}
// existing worker-stage dagger path stays unchanged
```

The error code is the existing `UNAUTHORIZED_SCOPE`
([src/knowledge/permissions.ts](src/knowledge/permissions.ts#L246-L280)).

Handler-side topic + preflight guard in
[src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts):

```ts
case "create_memory": {
  gateRole(role, "create");
  const scope = args.scope as KnowledgeScope;
  const scope_ref = args.scope_ref !== undefined ? String(args.scope_ref) : undefined;
  gateScope(role, "create", scope, scope_ref, { stageId: ctx.stageId });
  if (role === "librarian") {
    const topic = args.topic as { domain: string; subject: string; aspect?: string };
    if (topic?.domain !== "rag") throw new KnowledgeStoreError("UNAUTHORIZED_ROLE",
      "librarian writes restricted to topic.domain=rag");
    const allowed = new Set(["policy", "secret-incidents", "drift-incidents"]);
    if (!allowed.has(topic.subject)) throw new KnowledgeStoreError("UNAUTHORIZED_ROLE",
      "librarian topic.subject not allowed");
  }
  // ... existing createMemory call
}
case "update_memory": {
  gateRole(role, "create");
  // F03: preflight read existing record and run scope check (closes pre-existing gap).
  const existing = await getMemory(root, { id: String(args.id) });
  if (!existing) throw new KnowledgeStoreError("NOT_FOUND", `memory ${args.id} not found`);
  gateScope(role, "create", existing.scope, existing.scope_ref, { stageId: ctx.stageId });
  if (role === "librarian") {
    if (existing.topic?.domain !== "rag") throw new KnowledgeStoreError("UNAUTHORIZED_ROLE",
      "librarian cannot update non-rag memory");
    const allowed = new Set(["policy", "secret-incidents", "drift-incidents"]);
    if (!allowed.has(existing.topic.subject)) throw new KnowledgeStoreError("UNAUTHORIZED_ROLE",
      "librarian topic.subject not allowed");
  }
  // ... existing updateMemory call
}
```

The `update_memory` preflight check is an intentional improvement
that also fixes a pre-existing gap (coder/researcher updates were
not scope-checked). The current schema disallows patching `scope`
and `topic` so checking the existing record is equivalent to checking
the merged record.

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

`target_agents: ["librarian"]` keeps Librarian bookkeeping out of
other agents' eager-loaded context.

## 6. Operator Conflict Handling

When the operator manually edits `<projectRoot>/.saivage/saivage.json`
mid-process, F02 mutating calls surface `RAG_CONFIG_DRIFT`. The
Librarian:

- Does **not** read `.saivage/saivage.json` directly.
- Treats `rag_list` + `rag_stats` as the live manager view.
- Treats dispatch `context` as the operator's stated intent.
- Reports divergence; recommends `rag_register persist:true` to
  re-sync disk or operator restart for large divergence.
- Updates `policy` memory only after operator confirms which side
  wins.

## 7. Prompt Outline (`prompts/librarian.md`)

1. Role boundary (curate only; never edit source or plan).
2. Tool inventory (§4) and short purpose.
3. Discovery: always start with `rag_list`; cross-reference policy
   memories via `search_memories` topic.domain=rag.
4. Registration decision tree: chunker by extension; watcher by
   filesystem type; `persist:true` by default.
5. Destructive-action confirmation: re-dispatch with prefix
   `"confirmed: …"` before any `rag_drop` or rebuild.
6. No-hit handling: report empty hits; if `lastIngestAt` stale,
   recommend `rag_ingest`; never invent answers.
7. Per-error response (§8).
8. Secret-safe reporting (§1.7): counts + collection_id + operator
   context only; **never** dropped content; **never** invented path
   lists.
9. Operator conflict (§6).
10. Response shape: markdown with `Findings`, `Actions taken`,
    `Recommendations`, `Open questions`. No `create_note`; no plan
    proposals.

## 8. Per-Error Decision Tree

| Trigger                                  | Librarian response |
|------------------------------------------|--------------------|
| `RAG_DISABLED`                            | Refuse; recommend enabling and re-dispatch. |
| `RAG_UNAUTHORIZED_ROLE`                   | Should not occur (Librarian is in `RAG_ADMIN_ROLES`); if observed, report a wiring bug. |
| `RAG_INVALID_ARGS`                        | Report failed field; do not retry. |
| `RAG_DATASET_NOT_FOUND`                   | `rag_list`; suggest correct id or `rag_register`. |
| `RAG_PROTECTED_DATASET`                   | Redirect to `search_skills` / `search_memories`. |
| `RAG_BLOCKED_PATH`                        | Report blocked path; suggest permitted root inside the project. |
| `RAG_INVALID_QUERY_FILTER`                | Restate supported shape; one retry; then stop. |
| `RAG_CONFIG_DRIFT` / `RAG_EMBEDDING_DRIFT` / `RAG_CORRUPTED_STORE` | Diagnose live vs intent; require operator confirmation before destructive recovery (§6). |
| `RAG_PROVIDER_UNAVAILABLE`                | Recommend credential check; do not retry within dispatch. |
| `RAG_INGEST_LOCKED`                       | Note concurrent ingest; do not loop. |
| `RAG_WATCH_DISABLED`                      | Recommend updating `watch` via `rag_register persist:true`. |
| `RAG_WATCHER_UNAVAILABLE`                 | Quote message; recommend operator check FS watcher limits. |
| `RAG_PERSIST_FAILED`                      | Report `details.rollback`; recommend operator action. |
| `RAG_CONTROL_BUSY`                        | One retry; then fail. |
| `RAG_INTERNAL`                            | Quote message; recommend log inspection. |
| `RAG_SECRET_DROPPED` (reserved)           | Treat identically to `chunksDroppedSecrets > 0`. |
| `chunksDroppedSecrets > 0` on `rag_ingest`| Write a `secret-incidents` memory (§1.7). |
| Chokidar flood (operator-reported)        | Recommend narrower roots, broader `exclude`, polling. |
| Caller asks for recurring reconcile       | Refuse; recommend Planner stage. |
| Caller asks for stage proposal            | Refuse; place in final `Recommendations`. |
| `UNAUTHORIZED_ROLE` / `UNAUTHORIZED_SCOPE` from knowledge | Report wiring/topic violation; do not retry. |

## 9. Files

| File                                                                                | Action |
|--------------------------------------------------------------------------------------|--------|
| `prompts/librarian.md` (new)                                                        | Create per §7 |
| [src/agents/prompt-keys.ts](src/agents/prompt-keys.ts)                              | Add `"librarian"`. |
| [src/agents/prompts.ts](src/agents/prompts.ts)                                      | Extend `PROMPT_KEY_TO_ROLE` and `ROLE_PROMPT_NAMES`. |
| [src/agents/roster.ts](src/agents/roster.ts)                                        | Add ROSTER entry per §3.1; add `"librarian"` to `ToolFilterKind`. |
| [src/agents/tool-filters.ts](src/agents/tool-filters.ts)                            | Define `LIBRARIAN_TOOLS`; set `TOOL_FILTERS.librarian`. |
| [src/agents/base.ts](src/agents/base.ts#L1001-L1151)                                | Add `RUN_LIBRARIAN_SCHEMA`; extend `DISPATCH_SCHEMA_BY_TOOL`. |
| [src/server/bootstrap.ts](src/server/bootstrap.ts#L336)                             | Add `case "librarian"`; mutate `RagService.adminRoles.add("librarian")` during F03 init. |
| `src/agents/librarian.ts` (new)                                                     | `LibrarianAgent` class + `LibrarianInput`. |
| [src/knowledge/types.ts](src/knowledge/types.ts#L20)                                | Add `"librarian"` to `KnowledgeAgentRoleSchema`. |
| [src/knowledge/permissions.ts](src/knowledge/permissions.ts)                        | Add §5 row; extend `checkScope` (Librarian branch before existing worker-stage branch); use `UNAUTHORIZED_SCOPE`. |
| [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L193-L228)                  | §5 handler edits: preflight-read in `update_memory`, scope check, Librarian topic guard for both create and update; reuse existing `UNAUTHORIZED_ROLE` / `UNAUTHORIZED_SCOPE` codes. |
| `src/agents/librarian.test.ts` (new)                                                | Roster entry, filter membership including denies, prompt round-trip. |
| `src/agents/librarian.dispatch.test.ts` (new)                                       | Planner / Manager dispatch path; Chat denial; bootstrap switch coverage. |
| `src/agents/librarian.behaviour.test.ts` (new)                                      | Decision-tree branches with mocked F02 tools (drift confirmation gate; secret-incident memory write; protected-dataset redirect; no-hit fallback). |
| `src/knowledge/permissions.test.ts`                                                 | Librarian dagger; non-project deny; preserves existing worker dagger semantics. |
| `src/mcp/knowledgeMemory.test.ts`                                                   | Topic-guard rejection on create; update preflight scope check; topic guard on existing record at update; non-Librarian semantics unchanged. |
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
- No new ACL error code; uses existing `UNAUTHORIZED_ROLE` /
  `UNAUTHORIZED_SCOPE`.
- F02 is a hard prerequisite; F03 does not register any RAG tool
  itself.
