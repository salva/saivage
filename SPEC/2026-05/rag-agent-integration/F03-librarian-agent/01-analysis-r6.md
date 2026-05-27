# F03 — Librarian Agent: Functional Analysis

A single bounded **Librarian** agent that curates unprotected RAG
collections. It returns reports to its caller and never mutates plan
state, source files, or protected skill/memory collections.

## 1. Verified Facts

### 1.1 Dispatch

- [src/agents/roster.ts](src/agents/roster.ts#L30-L63) defines the
  roster shape.
- [src/agents/base.ts](src/agents/base.ts#L1001-L1151) maintains
  `DISPATCH_SCHEMA_BY_TOOL` keyed by tool name.
- [src/server/bootstrap.ts](src/server/bootstrap.ts#L336-L506)
  builds concrete agent instances via `switch (role)`.

Adding a non-worker `librarian` role requires `RUN_LIBRARIAN_SCHEMA`,
a roster entry, a bootstrap case mirroring the `inspector`
non-worker shape, and a new `LibrarianAgent` class.

### 1.2 Prompts

[src/agents/prompts.ts](src/agents/prompts.ts#L19-L46) loads
`prompts/<key>.md`; F03 adds `"librarian"` to `PROMPT_KEY_TO_ROLE`
and `ROLE_PROMPT_NAMES`.

### 1.3 Tool filter is presentation-only

[applyToolFilter](src/agents/tool-filters.ts#L31-L44) is name-only
and used when building the model-facing schema list. The runtime
dispatcher resolves tool names from the unfiltered catalog
([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L156-L194)).
Enforcement comes from F02's handler-side role check
(`RAG_UNAUTHORIZED_ROLE`) plus the knowledge handler's
`canCall`/`checkScope` calls. F03 still adds `"librarian"` to
`ToolFilterKind` so the Librarian's schema list is shaped correctly.

### 1.4 Knowledge ACL — current shape and limits

[permissions.ts](src/knowledge/permissions.ts#L29-L39):
`AccessCell = "Y" | "Y†" | "-"`.
[canCall](src/knowledge/permissions.ts#L222-L244) gates `(role, op,
kind)`.
[checkScope](src/knowledge/permissions.ts#L246-L292) returns
`ScopeCheckResult` with `code: "UNAUTHORIZED_SCOPE"` on failure;
the worker `Y†` branch requires `scope === "stage"` and `scope_ref
=== ctx.stageId`.

Handlers convert ACL failures to `KnowledgeStoreError` envelopes
with `UNAUTHORIZED_ROLE` / `UNAUTHORIZED_SCOPE` codes
([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L165-L181),
[src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L297-L301)).
F03 introduces no new code.

Current behaviour gaps relevant to F03:

- `create_memory` calls both `gateRole` and `gateScope` before
  `createMemory`
  ([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L193-L215)).
- `update_memory` calls `gateRole(role, "create")` but **does not
  call `gateScope`**
  ([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L216-L228)).
  Its schema disallows patching `scope` or `topic`
  ([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L51-L67)).

F03 deploys three cooperating enforcements:

1. A new permissions row for `librarian` with `Y†` on
   `create-memory` and `update-memory` only.
2. A `checkScope` extension with an explicit Librarian branch placed
   **before** the existing worker-stage branch: returns `{ ok: false,
   code: "UNAUTHORIZED_SCOPE", reason: "librarian writes restricted
   to scope=project" }` when `role === "librarian" && scope !==
   "project"`.
3. A handler-side topic + preflight guard in
   [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts):

   - For `create_memory` (after `gateRole`/`gateScope`): when `role
     === "librarian"`, require `args.topic.domain === "rag"` and
     `args.topic.subject ∈ {"policy","secret-incidents",
     "drift-incidents"}`. On failure raise
     `KnowledgeStoreError("UNAUTHORIZED_ROLE", ...)`.
   - For `update_memory`: read the prior record via
     `getMemory(root, { id })`, run `gateScope(role, "create",
     existing.scope, existing.scope_ref, { stageId: ctx.stageId })`,
     and run the same topic guard against `existing.topic`. The
     preflight closes the pre-existing scope-check gap for **every**
     role with `Y†` update authority and is documented as an
     intentional fix.

### 1.5 Tool name reality and F02 dependency

The seven RAG tools (`rag_list`, `rag_stats`, `rag_query`,
`rag_register`, `rag_ingest`, `rag_drop`, `rag_admin`) do not exist
in the current workspace
([src/mcp/builtins.ts](src/mcp/builtins.ts#L1912-L1966)). **F02 is a
hard prerequisite for F03**; the Librarian's roster entry, prompt,
whitelist, and decision tree assume the F02 surface is registered
before F03 loads.

### 1.6 Non-RAG tool name reality

Existing names in the Librarian whitelist:

- Filesystem reads: `read_file`, `list_dir`, `search_files`
  ([src/mcp/builtins.ts](src/mcp/builtins.ts#L401-L442)).
- Skill reads: `list_skills`, `read_skill`, `search_skills`
  ([src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts#L38-L132)).
- Memory reads: `list_memories`, `get_memory`, `search_memories`
  ([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L103-L128)).
- Memory writes: `create_memory`, `update_memory`
  ([src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L32-L69)).
- Synthetic: `read_stash`
  ([src/agents/base.ts](src/agents/base.ts#L674-L697)).

### 1.7 `IngestReport` shape

[IngestReport](src/rag/types.ts#L150-L159) exposes aggregate
counters only — `filesScanned`, `filesChanged`, `chunksUpserted`,
`chunksDeleted`, `chunksDroppedSecrets`, `tokensEmbedded`,
`embeddingMs`, `storeMs`. There is no path-level secret information.

The Librarian's secret-incident memory writes therefore carry only:

- `collection_id` of the affected dataset.
- `chunksDroppedSecrets` count from the ingest run.
- Caller-supplied free-text `context` (operator-supplied excerpt).

The memory body does **not** include `lastIngestAt` or any other
field beyond the three above. **FUP-INGEST-PATHS** records the
future request for F02 to expose a secret-safe path summary.

### 1.8 TaskReport / Issue shape

[TaskReportSchema](src/types.ts#L196-L215) carries `summary`,
`checklist_results` (with optional per-item `notes`),
`files_modified`, `files_created`, `tests_added`, `tests_run`,
`commits`, `issues_found: Issue[]`, truncation/failure flags, and
timestamps. There is no top-level `notes`, no `files_changed`, no
top-level `tests`.

`Issue` requires `severity` and `description`; it does **not** have
a `kind` field. A valid retrieval-gap issue is:

```ts
{ severity: "warning",
  description: "rag retrieval miss: <collection_id> — <query summary>" }
```

The downstream consumer of `issues_found` is the Manager's prompt
(the dispatcher itself does not auto-route on issues_found —
[src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L156-L249)
spawns the child and stringifies the child result). Auto-dispatch of
`run_librarian` from a worker's `issues_found` therefore happens
**at the Manager prompt level**, not by a runtime hook. F03's prompt
guidance instructs the Manager to inspect child `issues_found` for
the `"rag retrieval miss:"` prefix and dispatch `run_librarian`
accordingly.

## 2. Responsibilities

The Librarian's bounded decisions:

1. **Registration design.** Pick `chunker`, `sources` (one root),
   `watch`, `persist`; call `rag_register`. Refuse `source ∈
   {skill,memory}` upfront and relay the F02 `RAG_INVALID_ARGS`
   envelope.
2. **Source curation.** One source root per `fs` dataset (F02
   constraint).
3. **Watcher mode.** `false`, native `true`, or `{ usePolling: true }`.
4. **Reconcile.** On operator demand via `rag_admin reconcile`. Not
   a deletion path.
5. **Ingest on demand.** `rag_ingest` — also the deletion convergence
   path.
6. **Flood reports.** Recommend narrower roots, broader `exclude`,
   or polling; may call `rag_admin watch_disarm`/`watch_arm` after
   operator confirmation.
7. **Drift / corruption response.** On `RAG_CONFIG_DRIFT`,
   `RAG_EMBEDDING_DRIFT`, `RAG_CORRUPTED_STORE`: diagnose; propose
   `rag_drop` + `rag_register` + `rag_ingest`. Never execute
   destructive recovery without operator confirmation in the same
   dispatch reply.
8. **Secret-leak follow-up.** When `chunksDroppedSecrets > 0`,
   record a project-scope memory under topic `{domain:"rag",
   subject:"secret-incidents", aspect:<collection_id>}` carrying
   `count`, `collection_id`, and `context` only (§1.7).
9. **Policy memory upkeep.** Persist registration decisions as
   project-scope memories under topic `{domain:"rag",
   subject:"policy", aspect:<collection_id>}`.

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
on-disk layout
([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L110-L123)).
Conventions are warnings rather than hard enforcement
([src/agents/conventions.ts](src/agents/conventions.ts#L20-L31)).

`dispatchableBy: ["planner", "manager"]`. Chat is not granted
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
2. If retrieval misses or curation work is needed, the worker emits
   a `TaskReport.issues_found` entry of the form
   `{ severity: "warning", description: "rag retrieval miss:
   <collection_id> — <query summary>" }`
   ([src/types.ts](src/types.ts#L196-L215)). The Manager prompt is
   instructed (in its prompt file, not the runtime) to inspect child
   `issues_found` entries with that description prefix and dispatch
   `run_librarian` with the worker's findings in `context`.
3. Operator-driven requests reach the Librarian via Chat →
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

Per §1.3 this filter is presentation-only; the Librarian's actual
write authority is enforced by F02's handler role check
(`RAG_ADMIN_ROLES.has("librarian")` added by F03 in the F03
implementation step) and the knowledge handler's `gateRole` /
`gateScope` plus the Librarian topic guard (§1.4 / §5).

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
    if (topic?.domain !== "rag")
      throw new KnowledgeStoreError("UNAUTHORIZED_ROLE",
        "librarian writes restricted to topic.domain=rag");
    const allowed = new Set(["policy", "secret-incidents", "drift-incidents"]);
    if (!allowed.has(topic.subject))
      throw new KnowledgeStoreError("UNAUTHORIZED_ROLE",
        "librarian topic.subject not allowed");
  }
  // existing createMemory call
}
case "update_memory": {
  gateRole(role, "create");
  const existing = await getMemory(root, { id: String(args.id) });
  if (!existing)
    throw new KnowledgeStoreError("NOT_FOUND", `memory ${args.id} not found`);
  gateScope(role, "create", existing.scope, existing.scope_ref,
            { stageId: ctx.stageId });
  if (role === "librarian") {
    if (existing.topic?.domain !== "rag")
      throw new KnowledgeStoreError("UNAUTHORIZED_ROLE",
        "librarian cannot update non-rag memory");
    const allowed = new Set(["policy", "secret-incidents", "drift-incidents"]);
    if (!allowed.has(existing.topic.subject))
      throw new KnowledgeStoreError("UNAUTHORIZED_ROLE",
        "librarian topic.subject not allowed");
  }
  // existing updateMemory call
}
```

The `update_memory` preflight is an intentional improvement that
also closes a pre-existing gap (coder/researcher updates were not
scope-checked). The current schema disallows patching `scope` and
`topic`, so checking the prior record is equivalent to checking the
merged record.

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
6. No-hit handling: report empty hits; if ingest is stale per
   `rag_stats`, recommend `rag_ingest`; never invent answers.
7. Per-error response (§8).
8. Secret-safe reporting (§1.7): `count` + `collection_id` +
   operator-supplied `context` only; **never** dropped content;
   **never** invented path lists.
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
| `chunksDroppedSecrets > 0` on `rag_ingest`| Write a `secret-incidents` memory (§1.7) with `count`, `collection_id`, and operator `context` only. |
| Chokidar flood (operator-reported)        | Recommend narrower roots, broader `exclude`, polling. |
| Caller asks for recurring reconcile       | Refuse; recommend Planner stage. |
| Caller asks for stage proposal            | Refuse; place in final `Recommendations`. |
| `UNAUTHORIZED_ROLE` / `UNAUTHORIZED_SCOPE` from knowledge | Report wiring/topic violation; do not retry. |

## 9. Files

| File                                                                                | Action |
|--------------------------------------------------------------------------------------|--------|
| `prompts/librarian.md` (new)                                                        | Create per §7. |
| [src/agents/prompt-keys.ts](src/agents/prompt-keys.ts)                              | Add `"librarian"`. |
| [src/agents/prompts.ts](src/agents/prompts.ts)                                      | Extend `PROMPT_KEY_TO_ROLE` and `ROLE_PROMPT_NAMES`. |
| [src/agents/roster.ts](src/agents/roster.ts)                                        | Add ROSTER entry per §3.1; add `"librarian"` to `ToolFilterKind`. |
| [src/agents/tool-filters.ts](src/agents/tool-filters.ts)                            | Define `LIBRARIAN_TOOLS`; set `TOOL_FILTERS.librarian`. |
| [src/agents/base.ts](src/agents/base.ts#L1001-L1151)                                | Add `RUN_LIBRARIAN_SCHEMA`; extend `DISPATCH_SCHEMA_BY_TOOL`. |
| [src/server/bootstrap.ts](src/server/bootstrap.ts#L336)                             | Add `case "librarian"`; F03 init also mutates `RagService.adminRoles.add("librarian")`. |
| `src/agents/librarian.ts` (new)                                                     | `LibrarianAgent` class + `LibrarianInput`. |
| [src/knowledge/types.ts](src/knowledge/types.ts#L20)                                | Add `"librarian"` to `KnowledgeAgentRoleSchema`. |
| [src/knowledge/permissions.ts](src/knowledge/permissions.ts)                        | Add §5 row; extend `checkScope` (Librarian branch placed before existing worker-stage branch); reuse `UNAUTHORIZED_SCOPE`. |
| [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L193-L228)                  | §5 handler edits: `update_memory` preflight scope check, Librarian topic guard for both create and update; reuse existing `UNAUTHORIZED_ROLE` / `UNAUTHORIZED_SCOPE` codes. |
| `prompts/manager.md`                                                                | Add Manager-prompt rule: inspect child `TaskReport.issues_found` for descriptions starting with `"rag retrieval miss:"` and dispatch `run_librarian` with the issue as `context`. |
| `src/agents/librarian.test.ts` (new)                                                | Roster entry, filter membership including denies, prompt round-trip. |
| `src/agents/librarian.dispatch.test.ts` (new)                                       | Planner / Manager dispatch path; Chat denial; bootstrap switch coverage. |
| `src/agents/librarian.behaviour.test.ts` (new)                                      | Decision-tree branches with mocked F02 tools (drift confirmation gate; secret-incident memory write payload; protected-dataset redirect; no-hit fallback). |
| `src/knowledge/permissions.test.ts`                                                 | Librarian dagger; non-project deny; preserves existing worker dagger semantics. |
| `src/mcp/knowledgeMemory.test.ts`                                                   | Topic-guard rejection on create; update preflight scope check; topic guard on existing record at update; non-Librarian semantics unchanged. |
| `SPEC/v2/rag/librarian.md` (new)                                                    | Operator-facing contract. |

## 10. Non-Goals

- No new runtime mechanism in [src/runtime/](src/runtime/) (no
  runtime hook on `issues_found`; auto-dispatch is Manager-prompt
  level only).
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
- Secret-incident memory body carries only `count`, `collection_id`,
  and operator `context` — no `lastIngestAt`, no path lists, no
  dropped content.
- F02 is a hard prerequisite; F03 does not register any RAG tool
  itself.
