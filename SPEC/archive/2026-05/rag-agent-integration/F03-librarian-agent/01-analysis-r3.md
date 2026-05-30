# F03 — Librarian Agent: Functional Analysis

This analysis introduces a single bounded **Librarian** agent that
curates unprotected RAG collections. It returns reports to its caller
and never mutates plan state, source files, or protected
skill/memory collections. It uses real, verified agent-framework
seams.

## 1. Verified Agent-Framework Facts

### 1.1 Dispatch

Dispatch tools are roster-keyed but their JSON schemas are explicit:

- [src/agents/roster.ts](src/agents/roster.ts#L352) declares each
  role's `dispatchTool` and `dispatchableBy`.
- [src/agents/base.ts](src/agents/base.ts#L1121) holds the manual
  `DISPATCH_SCHEMA_BY_TOOL` record keyed by tool name. The roster
  validates against this record at module-load
  ([src/agents/base.ts](src/agents/base.ts#L1137)).
- [src/server/bootstrap.ts](src/server/bootstrap.ts#L336) instantiates
  the concrete agent class via `switch (role)`.

Adding a non-worker role like `librarian` therefore requires:

1. New `RUN_LIBRARIAN_SCHEMA` constant + entry in
   `DISPATCH_SCHEMA_BY_TOOL`.
2. New `case "librarian"` in the bootstrap switch.
3. New `src/agents/librarian.ts` implementing `LibrarianAgent`.

There is **no** `Handoff` envelope module; the existing
[src/agents/handoff.ts](src/agents/handoff.ts) just builds shared
free-text context.

### 1.2 Prompts

[src/agents/prompts.ts](src/agents/prompts.ts#L19-L46) loads
`prompts/<key>.md` and maps `RolePromptName` (declared in
[src/agents/prompt-keys.ts](src/agents/prompt-keys.ts)) via
`PROMPT_KEY_TO_ROLE` and `ROLE_PROMPT_NAMES`. Adding the Librarian
requires: a new `prompts/librarian.md`; `"librarian"` in
`RolePromptName`; and matching entries in `PROMPT_KEY_TO_ROLE` and
`ROLE_PROMPT_NAMES`.

### 1.3 Tool filtering

[applyToolFilter](src/agents/tool-filters.ts#L31-L44) is name-only,
keyed on `ToolFilterKind`. F03 adds a new `"librarian"` member to the
union and a matching predicate.

### 1.4 Knowledge ACL

[KnowledgeAgentRoleSchema](src/knowledge/types.ts#L20-L31) is its own
enum independent of `AgentRole`. F03 extends it with `"librarian"`
and adds a row in
[src/knowledge/permissions.ts](src/knowledge/permissions.ts) keyed by
(role, op, kind, scope) — the permission helper does **not** key on
memory topic, so the topic-scoping constraints live in the prompt and
in the Librarian's behaviour, not in the ACL.

### 1.5 Concrete tool names

Confirmed from
[src/mcp/builtins.ts](src/mcp/builtins.ts#L1958-L1971) and the F02
analysis:

- File reads: `read_file`, `list_dir`, `search_files`. No `stat_file`.
- Skill reads: `list_skills`, `read_skill`, `search_skills`.
- Memory reads: `list_memories`, `get_memory`, `search_memories`.
- Memory writes (Librarian-scope only): `create_memory`,
  `update_memory`.
- RAG (from F02): `rag_list`, `rag_stats`, `rag_query`,
  `rag_register`, `rag_ingest`, `rag_drop`, `rag_admin`.

There is no `propose_stage`, no `read_skill_by_id`, no `stat_file`,
no `create_note` in the Librarian whitelist (Chat's `create_note`
relays to Planner; the Librarian returns reports to its caller and
does not write Planner-bound notes).

### 1.6 Conventions

[src/agents/conventions.ts](src/agents/conventions.ts) is a static
write-territory check used by `checkConvention`. It does not inject
prompt context at runtime. Any "current policy" content the Librarian
needs is discovered live via `search_memories` and `rag_list`.

## 2. Responsibilities

The Librarian's bounded decisions, all returning a report to the
caller and never autonomously mutating plan state:

1. **Registration design.** Choose `chunker`, `sources`, `watch`, and
   `persist` for a new unprotected collection; call
   `rag_register`. Refuse `source ∈ {skill, memory}` upfront and
   relay `RAG_PROTECTED_SOURCE`.
2. **Source curation.** Choose `sources[]` (root + include + exclude).
3. **Watcher mode.** Choose `false`, native `true`, or
   `{ usePolling: true }` (LXC bind-mounts, NFS).
4. **Reconcile.** Run `rag_admin action: "reconcile"` on operator
   demand, after a manual file edit, or after a flood report. Not on
   a schedule — there is no scheduler.
5. **Ingest on demand.** Run `rag_ingest` against an already-registered
   `fs` collection.
6. **Flood reports.** When the operator surfaces a chokidar flood (via
   chat or log), recommend narrower `sources`, broader `exclude`, or
   polling mode. Optionally call `rag_admin watch_disarm` /
   `watch_arm` after operator confirmation.
7. **Drift / corruption response.** On `RAG_CONFIG_DRIFT`,
   `RAG_EMBEDDING_DRIFT`, `RAG_CORRUPTED_STORE`, diagnose and propose
   a rebuild path (`rag_drop` then `rag_register` then `rag_ingest`).
   Never execute the destructive recovery without operator (or
   dispatching Planner) confirmation in the same dispatch reply.
8. **Secret-leak follow-up.** When `rag_ingest` returns
   `chunksDroppedSecrets > 0`, record a project-scope memory with
   topic `{domain:"rag", subject:"secret-incidents", aspect:<collection_id>}`
   listing the affected paths (counts and path glob summary only;
   never the dropped content).
9. **Policy memory upkeep.** Persist registration decisions as
   project-scope memories under topic
   `{domain:"rag", subject:"policy", aspect:<collection_id>}` so the
   Librarian's next session can rediscover them via
   `search_memories`.

Explicitly out of scope:

- Plan mutation (no plan tools granted).
- Source-file editing or `run_command`.
- Skill writes or any supersede/archive/delete on either kind.
- Operating on protected datasets through F02 mutating tools.
- Routing incidents to other agents (no supervisor queue exists).
- Recurring reconcile or scheduled work (no scheduler; recurring work
  belongs to Planner stages, which the Librarian only recommends).

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
    description: "Librarian only edits RAG configuration via tools and policy memories; no source files.",
  },
  defaultModelKey: "orchestrator",
  displayName: "Librarian",
  summary: "Curates unprotected RAG collections — registers, ingests, queries, prunes, and diagnoses drift. Returns reports; never edits source files, protected collections, or plan state.",
  workerInit: null,
}
```

`dispatchableBy: ["planner", "manager"]` — Planner authors stage-level
collection work; Manager dispatches Librarian during a stage to answer
a curation question. **Chat is not granted** `run_librarian` because
the existing [prompts/chat.md](prompts/chat.md) routes actionable work
through Planner via `create_note`, and adding direct Librarian
dispatch would create a second planning influence channel inconsistent
with the current architecture. Operators who want Librarian work go
through Planner.

### 3.2 Dispatch wiring

- Add `RUN_LIBRARIAN_SCHEMA` (one required `objective: string`,
  optional `collection_id: string`, optional `context: string`) to
  [src/agents/base.ts](src/agents/base.ts).
- Add it to `DISPATCH_SCHEMA_BY_TOOL`.
- Add a `case "librarian"` to the bootstrap switch in
  [src/server/bootstrap.ts](src/server/bootstrap.ts#L336) that
  constructs `LibrarianAgent` (mirroring the `inspector` case shape
  since both are non-worker, non-stage-scoped).
- New `src/agents/librarian.ts` extending `BaseAgent` with a
  `LibrarianInput` interface for the schema above.

### 3.3 Alternative dispatch paths considered and rejected

- **Supervisor incident routing.** Supervisor only inspects logs and
  cancels stuck agents
  ([src/runtime/supervisor.ts](src/runtime/supervisor.ts)). It has no
  queue and no destination-role API. Adding one is new runtime code
  the topic and architecture-first rule disallow.
- **Dispatcher auto-routing on retrieval intent.** Surface-string
  heuristics in the dispatcher blur ownership. Callers explicitly
  dispatch.
- **Chat handoff.** Rejected; see §3.1.

## 4. Tool Whitelist

Add a new `ToolFilterKind` value `"librarian"`. The set:

```ts
const LIBRARIAN_TOOLS = new Set<string>([
  // RAG (F02), full surface
  "rag_list", "rag_stats", "rag_query",
  "rag_register", "rag_ingest", "rag_drop", "rag_admin",
  // File reads
  "read_file", "list_dir", "search_files",
  // Knowledge reads (skill + memory)
  "list_skills", "read_skill", "search_skills",
  "list_memories", "get_memory", "search_memories",
  // Memory writes — only create/update; the prompt restricts topics
  "create_memory", "update_memory",
  // Stash for handoff context
  "read_stash",
]);

TOOL_FILTERS.librarian = (name) => LIBRARIAN_TOOLS.has(name);
```

Explicitly **not** granted: `create_note`, `archive_memory`,
`delete_memory`, `supersede_memory`, every `*-skill` write, every
`plan_*` tool, `run_command`, every `run_<role>` dispatch tool,
`web_search`, `fetch_url`, `read_file_range` (if added later), all
`write_file` variants.

## 5. Knowledge ACL Row

In [src/knowledge/permissions.ts](src/knowledge/permissions.ts), add
the Librarian row. Y / N matrix (Y = allowed):

| op           | scope=project | scope=stage | scope=session |
|--------------|---------------|-------------|---------------|
| `read-*` (skill, memory)        | Y | Y | Y |
| `list-*` (skill, memory)        | Y | Y | Y |
| `search-*` (skill, memory)      | Y | Y | Y |
| `create-memory`                 | Y | N | N |
| `update-memory`                 | Y | N | N |
| `supersede-memory`              | N | N | N |
| `archive-memory`                | N | N | N |
| `delete-memory`                 | N | N | N |
| `create-skill`                  | N | N | N |
| `update-skill`                  | N | N | N |
| `supersede-skill`               | N | N | N |
| `archive-skill`                 | N | N | N |
| `delete-skill`                  | N | N | N |

`KnowledgeAgentRoleSchema` is extended to include `"librarian"`.

Topic scoping (`domain="rag"`, subject ∈ `{"policy", "secret-incidents",
"drift-incidents"}`) is enforced by the **prompt**, not the ACL helper.
The prompt outline (§7) is explicit about this.

Memory record shape for Librarian writes:

```ts
{
  scope: "project",
  topic: { domain: "rag", subject: <"policy" | "secret-incidents" | "drift-incidents">, aspect: <collection_id> },
  target_agents: ["librarian"],   // self-targeted; not loaded into other agents' contexts
  survive_compaction: true,
  body: "<markdown report>",
}
```

`target_agents: ["librarian"]` keeps the Librarian's bookkeeping out
of every other agent's eager-loaded context.

## 6. Operator Conflict Handling

When the operator manually edits `<projectRoot>/.saivage/saivage.json`
mid-process, the F02 tools surface a divergence as `RAG_CONFIG_DRIFT`
on the next mutating call. Sources of truth for the Librarian when
asked to "reconcile after manual edit":

1. **Live manager view** via `rag_list` and `rag_stats`. These
   reflect what the running process believes, not necessarily the
   freshly-edited disk config.
2. **Operator's stated intent**, supplied through the dispatch input
   `context` field. This is the authoritative description of what the
   operator changed.

The Librarian:

- Does not read `.saivage/saivage.json` directly (it would expose
  sensitive provider fields it has no reason to handle).
- Reports the divergence by comparing live view to the operator's
  stated intent.
- Recommends the operator restart the harness if the divergence is
  large, or accept the live view and call `rag_register persist:true`
  to re-write the disk config to match.
- Updates its `policy` memory only after the operator confirms which
  side wins; never silently overwrites prior policy.

## 7. Prompt Outline (`prompts/librarian.md`)

The new prompt covers, in order:

1. **Role boundary.** "You curate unprotected RAG collections only.
   You never edit source files, plan stages, or run shell commands.
   You return a markdown report; the caller decides what to act on."
2. **Tool inventory.** Exact names and short purpose of each tool in
   §4. Reminder that protected collections (skills, memory) are
   read-only through `rag_query` and that knowledge ACL writes are
   limited to project-scope policy/incident memories.
3. **Discovery.** Start every task with `rag_list`. For an existing
   collection, `rag_stats`. Cross-reference policy memories via
   `search_memories` with `topic.domain = "rag"`.
4. **Registration decision tree.** Chunker picker (`markdown` for
   `.md|.mdx|.rst|.txt`; `code` for source trees; `memory` chunker
   reserved for F01-owned datasets and therefore unused here).
   Watcher picker (`false` for one-shot ingests, native `true` for
   reliable FS, `{usePolling:true}` for bind-mounts/NFS; default
   polling interval 2000 ms). `persist:true` is the default unless
   the operator asks for an ephemeral session-only collection.
5. **Destructive-action confirmation.** Before any `rag_drop` or
   rebuild on a non-empty dataset, restate the consequence in the
   reply and require the caller (Planner / Manager) to re-dispatch
   with `objective: "confirmed: <previous objective>"`. The Librarian
   never recovers silently.
6. **No-hit handling.** If `rag_query` returns `hits: []`, say so,
   suggest broadening filters, and if `lastIngestAt` is stale,
   recommend `rag_ingest`. Do not invent answers.
7. **Per-error response.** §8 table below; the prompt includes a
   summary instructing the model to consult the same playbook.
8. **Secret-safe reporting.** If `chunksDroppedSecrets > 0`, write a
   `secret-incidents` memory with **counts and path glob summary only;
   never the dropped content**. Reply to the caller with the same
   summary.
9. **Operator conflict.** Honour §6's rules; recommend restart or
   `rag_register persist:true` re-write; never silently re-register.
10. **Response shape.** Every dispatch reply is markdown with sections
    `Findings`, `Actions taken`, `Recommendations`, `Open questions`.
    The body of the reply is what the caller sees; there is no
    `create_note` and no plan-stage proposal.

## 8. Per-Error Decision Tree

Maps every error code F02 publishes plus events the Librarian
encounters:

| Trigger                                  | Librarian response                                                                                                  |
|------------------------------------------|----------------------------------------------------------------------------------------------------------------------|
| `RAG_DISABLED`                            | Refuse; recommend operator enable `config.rag.enabled` and re-dispatch.                                              |
| `RAG_INVALID_ARGS`                        | Report which field failed schema validation; do not retry.                                                           |
| `RAG_DATASET_NOT_FOUND`                   | Run `rag_list`; suggest correct id or propose `rag_register`.                                                        |
| `RAG_PROTECTED_DATASET`                   | Redirect caller to `search_skills` / `search_memories`. No retry. Mention F01's owner.                               |
| `RAG_PROTECTED_SOURCE`                    | Refuse registration; explain that skill/memory datasets are F01-owned.                                               |
| `RAG_BLOCKED_PATH`                        | Report the blocked path; suggest a permitted root inside the project.                                                |
| `RAG_INVALID_QUERY_FILTER`                | Restate supported filter shape; retry once with corrected filter; otherwise report and stop.                         |
| `RAG_CONFIG_DRIFT`                        | Diagnose live vs. stated intent; require operator/Planner confirmation before any `rag_drop`. See §6.                |
| `RAG_EMBEDDING_DRIFT`                     | Same as drift; never auto-recover.                                                                                    |
| `RAG_CORRUPTED_STORE`                     | Quote the named path; propose rebuild path with explicit confirmation gate.                                          |
| `RAG_PROVIDER_UNAVAILABLE`                | Recommend checking provider credentials; do not retry within the dispatch.                                            |
| `RAG_INGEST_LOCKED`                       | Advise a concurrent ingest is in flight; do not loop; one retry only if caller insists.                              |
| `RAG_WATCH_DISABLED`                      | Recommend updating `watch` via `rag_register` (with `persist: true`).                                                 |
| `RAG_WATCHER_UNAVAILABLE` (via `rag_stats.watch === "unavailable"`) | Recommend `{usePolling:true}` and narrower roots; quote the error message verbatim if available. |
| `RAG_PERSIST_FAILED`                      | Report partial failure with `details.rollback` value; recommend operator action.                                     |
| `RAG_CONTROL_BUSY`                        | Wait and retry once; if still busy, return the failure to the caller.                                                |
| `RAG_INTERNAL`                            | Quote the message; recommend operator inspect the log; do not retry.                                                 |
| `chunksDroppedSecrets > 0` on `rag_ingest`| Write `secret-incidents` memory (counts + path globs); tell caller their content was scrubbed in-pipeline.           |
| Chokidar flood report (from operator log) | Recommend narrower roots, broader `exclude`, or `{usePolling:true}`. Draft a `rag_register persist:true` call.        |
| Caller asks for a recurring reconcile     | Refuse; explain no scheduler; recommend a Planner stage that calls `rag_admin reconcile`.                            |
| Caller asks Librarian to propose a stage  | Refuse; place the recommendation in the final report's `Recommendations`.                                            |

## 9. Files

| File                                                                                | Action  |
|--------------------------------------------------------------------------------------|---------|
| `prompts/librarian.md` (new)                                                        | Create  |
| [src/agents/prompt-keys.ts](src/agents/prompt-keys.ts)                              | Edit — add `"librarian"`. |
| [src/agents/prompts.ts](src/agents/prompts.ts)                                      | Edit — `PROMPT_KEY_TO_ROLE.librarian = "librarian"`; add to `ROLE_PROMPT_NAMES`. |
| [src/agents/roster.ts](src/agents/roster.ts)                                        | Edit — add `librarian` ROSTER entry; add `"librarian"` to `ToolFilterKind`. |
| [src/agents/tool-filters.ts](src/agents/tool-filters.ts)                            | Edit — define `LIBRARIAN_TOOLS` and `TOOL_FILTERS.librarian`. |
| [src/agents/base.ts](src/agents/base.ts)                                            | Edit — add `RUN_LIBRARIAN_SCHEMA`; add to `DISPATCH_SCHEMA_BY_TOOL`. |
| [src/server/bootstrap.ts](src/server/bootstrap.ts)                                  | Edit — add `case "librarian"` constructing `LibrarianAgent.create(...)`. |
| `src/agents/librarian.ts` (new)                                                     | Create the `LibrarianAgent` class and `LibrarianInput` interface. |
| [src/knowledge/types.ts](src/knowledge/types.ts)                                    | Edit — add `"librarian"` to `KnowledgeAgentRoleSchema`. |
| [src/knowledge/permissions.ts](src/knowledge/permissions.ts)                        | Edit — add the row in §5. |
| `src/agents/librarian.test.ts` (new)                                                | Create — roster entry shape, filter membership including all denies, prompt round-trip, knowledge ACL matrix coverage. |
| `src/agents/librarian.dispatch.test.ts` (new)                                       | Create — Planner and Manager can dispatch `run_librarian`; Chat cannot; child-spawner constructs `LibrarianAgent`. |
| `src/agents/librarian.behaviour.test.ts` (new)                                      | Create — representative decision-tree branches with mocked F02 tools (`RAG_CONFIG_DRIFT` confirmation gate; `chunksDroppedSecrets > 0` memory write; protected-dataset redirect; no-hit fallback). |
| `SPEC/v2/rag/librarian.md` (new)                                                    | Operator-facing contract.       |

## 10. Non-Goals

- No new runtime mechanism in [src/runtime/](src/runtime/).
- No supervisor incident routing.
- No dispatcher auto-routing.
- No plan-stage proposal tool, no `create_note` grant.
- No scheduler.
- No source-file mutation.
- No write access to protected `skill`/`memory` collections.
- No knowledge writes outside project-scope `topic.domain="rag"`
  memories (topic enforcement lives in the prompt; ACL enforces
  project-scope and op kind).
