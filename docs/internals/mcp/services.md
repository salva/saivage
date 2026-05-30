# MCP services catalog

[`src/mcp/builtins.ts`](https://github.com/salva/saivage/blob/main/src/mcp/builtins.ts)

Complete catalog of MCP services available to Saivage agents. Services
are either **built-in** (shipped with Saivage, registered on startup) or
**externally declared** in `.saivage/saivage.json` under `mcpServers`.

Core services (filesystem, shell, data, git, skills, memory, plan, notes,
and rag) run **in-process** — direct function calls inside the Node.js
process, no subprocess overhead. Services that need external dependencies
not yet integrated (web, lock, index) are registered as unavailable stubs;
they appear in API discovery with `available: false` but are not advertised
to agent LLM calls.

External services declared in `.saivage/saivage.json` under `mcpServers`
are started at boot only when `disabled: false` and `autostart: true`.
Health checks, idle shutdown, restart, and cooldown handling for those
external clients are managed by `McpRuntime`. See [mcp/runtime](./runtime).

## Service inventory

| Service | Origin | Transport | Purpose |
|---------|--------|-----------|---------|
| [Filesystem](#_1-filesystem) | builtin | in-process | File read/write/search |
| [Shell](#_2-shell) | builtin | in-process | Command execution |
| [Git](#_3-git) | builtin | in-process | Version control |
| [Data](#_4-data) | builtin | in-process | Web search, HTTP fetch, downloads, URL metadata |
| [Plan](#_5-plan) | builtin | in-process | Plan state management |
| [Skills](#_6-skills) | builtin | in-process | Skill records: CRUD + lifecycle + search |
| [Memory](#_7-memory) | builtin | in-process | Memory records: CRUD + lifecycle + topic/keyword retrieval |
| [RAG](#_8-rag) | builtin | in-process | Semantic collection registration, ingest, query, and admin |
| [Notes](#_9-notes) | builtin | in-process | Create Planner notes from tool calls |
| [Agent dispatch](#_10-agent-dispatch) | runtime | in-process | Parent -> child agent invocation |
| Web / index / lock | builtin | unavailable stub | Discovery-only placeholders; not advertised to agents |
| External | declared | stdio / sse | User-declared services in `mcpServers` |

## Agent → service access matrix

Which tools agents see in their LLM tool schemas is controlled by
`BaseAgent.getToolSchemas()` and `applyToolFilter()`. Some in-process
handlers also enforce their own ACL with `ToolCallContext`; those handler
checks are listed in the service sections below.

| Tool group | Planner | Manager | Coder | Researcher | Data Agent | Inspector | Reviewer | Designer | Critic | Chat | Librarian |
|------------|---------|---------|-------|------------|------------|-----------|----------|----------|--------|------|-----------|
| Filesystem read (`read_file`, `list_dir`, `search_files`) | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Filesystem write (`write_file`) | no | yes | yes | yes | yes | no | no | yes | no | no | no |
| Shell (`run_command`) | no | yes | yes | yes | yes | yes | yes | yes | yes | no | no |
| Git read (`git_status`, `git_log`, `git_diff`) | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | no |
| Git mutation | no | yes | yes | yes | yes | no | no | yes | no | no | no |
| Data lookup (`web_search`, `fetch_url`, `fetch_page_text`) | no | yes | yes | yes | yes | yes | no | yes | no | yes | no |
| Data download / metadata | no | yes | yes | yes | yes | no | no | yes | no | no | no |
| Plan | yes | no | no | no | no | no | no | no | no | no | no |
| Notes (`create_note`) | no | yes | yes | yes | yes | no | no | yes | no | yes | no |
| RAG read (`rag_list`, `rag_stats`, `rag_query`) | no | yes | yes | yes | yes | no | no | yes | no | no | yes |
| RAG admin | no | advertised, denied by handler | advertised, denied by handler | advertised, denied by handler | advertised, denied by handler | no | no | advertised, denied by handler | no | no | yes |
| Agent dispatch | `run_manager`, `run_inspector`, `run_librarian` | workers + `run_librarian` | no | no | no | no | no | no | no | no | no |

**Skills + Memory ACL.** The handler-level operation matrix (create /
update / supersede / archive / delete / list / read / search, split by
kind) is documented in
[knowledge/skills-and-memory](../knowledge/skills-and-memory). Key facts:

- **Skill writes:** Manager is handler-authorized for create / update /
  supersede / archive / delete. Inspector is handler-authorized for
  supersede / archive / delete, but not create / update. Current role
  filtering advertises the non-create, non-update skill mutation tools to
  every worker-filter role; the handler still authorizes only Manager and
  Inspector, so non-Manager workers are denied at call time.
- **Memory writes:** Planner, Manager, Inspector own the full lifecycle
  (including supersede / archive). Coder / Researcher may `create_memory` /
  `update_memory` only with `scope == "stage"` and
  `scope_ref == <current stage_id>`. Librarian may create / update only
  project-scope memories whose topic is `rag/policy`,
  `rag/secret-incidents`, or `rag/drift-incidents`. Data Agent, Reviewer,
  Designer, Critic, and Chat are denied memory writes by the handler even
  if a broad role filter advertises the tool.
- **Reads:** handler permissions allow every role to read/search skills;
  memory reads/searches are allowed to every role except Data Agent.
  The advertised tool surface is narrower for some roles; for example,
  Planner, Inspector, Reviewer, Critic, and Chat currently see skill
  list/read tools but not `search_skills`.
- **Chat's live write surface is notes only.** `/remember` / `/forget` are
  inter-agent messages to Planner; Planner decides whether to call memory
  lifecycle tools.

## 1. Filesystem

**Origin:** builtin · **Implementation:** `src/mcp/builtins.ts` (in-process)

The handler enforces a project-root sandbox by `path.resolve` + prefix
check; absolute paths outside the project root are rejected. Generic
filesystem writes targeted at `.saivage/skills/` or `.saivage/memory/`
are rejected inline by `write_file`; knowledge changes must go through the
skills / memory MCP tools.

### `read_file`

Read a windowed slice of a UTF-8 file. Returns up to `mcp.maxFileReadBytes`
bytes per call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute or project-relative file path |
| `offset` | integer | no | Byte offset to start reading from (default 0). Non-negative integer. |
| `length` | integer | no | Maximum bytes to read (defaults to `mcp.maxFileReadBytes`, capped by it). Non-negative integer. |

**Returns:** `{ content, offset, length, size_bytes, truncated }` where
`truncated` is `true` when `offset + length < size_bytes`.

**Error codes:** `INVALID_ARGUMENT`, `FILE_TOO_LARGE`, `LENGTH_TOO_LARGE`,
`INVALID_RANGE`, `BINARY_CONTENT`, `NOT_A_FILE`, `NOT_FOUND`,
`PERMISSION_DENIED`, `IO_ERROR`. Binary content is detected by a 4 KiB
NUL-byte probe at the file head, independent of `offset`.

### `write_file`

Write full UTF-8 file content. Creates parent directories if needed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | File path |
| `content` | string | yes | Full file content |

**Returns:** `{ written: true, path }`

### `list_dir`

Directory listing with file/directory flags.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Directory path |

**Returns:** `{ entries: [{ name, type: "file" | "dir" }] }`

### `search_files`

Search for files matching a glob pattern.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `directory` | string | yes | Root directory to search |
| `pattern` | string | yes | Glob pattern (e.g., `**/*.ts`) |

**Returns:** `{ files, truncated, truncated_reason, max_results, max_depth, max_ms, skipped? }`

## 2. Shell

**Origin:** builtin · **Implementation:** `src/mcp/builtins.ts` (in-process)

Commands run with the daemon's environment, with `PROJECT_ROOT` injected.
Stdout / stderr are captured (truncated to a configured byte limit) and
returned as the tool result. There is **no** allow-list — sandboxing is the
job of the LXC container.

### `run_command`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | string | yes | — | Shell command to run |
| `cwd` | string | no | project root | Working directory |
| `timeout_ms` | number | no | derived cap | Hard wall-clock timeout in ms. Omitted / `0` still uses the service cap derived from `mcp.shellTimeoutMs`; lower nonzero values are raised to `mcp.shellTimeoutFloorMs`. |
| `timeout` | number | no | derived cap | Deprecated alias for `timeout_ms` |
| `inactivity_timeout_ms` | number | no | disabled | No-output-growth timeout in ms; terminates when stdout/stderr log files do not grow for this long; `0` disables. Lower nonzero values are raised to `mcp.shellTimeoutFloorMs`. |
| `idle_timeout_ms` | number | no | none | Deprecated alias for `inactivity_timeout_ms` |
| `stdout_path` | string | no | auto | Project-relative file path for full stdout log |
| `stderr_path` | string | no | auto | Project-relative file path for full stderr log |

**Returns:** `{ stdout, stderr, exitCode, stdout_path, stderr_path, stdout_bytes, stderr_bytes, started_at, completed_at, duration_ms, last_output_at }`

Full output is written to project-local log files. Returned `stdout` /
`stderr` are capped tails of those logs. Timeouts return `exitCode: 124`
and include the timeout reason in `stderr`, including the last observed
output timestamp for inactivity timeouts. Long-running commands should
emit periodic stdout / stderr and set `inactivity_timeout_ms` when no log
growth means the process is unhealthy.

## 3. Git

**Origin:** builtin · **Implementation:** `src/mcp/builtins.ts` (in-process,
wraps `git` CLI)

Git operations exposed to agents go through this service. The Plan service
also uses `git_commit` for plan-file commits. The current live abort /
supervisor paths do not automatically run `git checkout -- .`.

### `git_commit`

Stage specified files and commit. **Requires explicit file lists** —
unlike v1, there is no implicit `["."]` staging.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `files` | string[] | yes | Files to stage (relative to project root) |
| `message` | string | yes | Commit message |
| `task_id` | string | no | If provided, message is prefixed with `[tsk-<id>]` |

**Returns:** `{ sha }` or `{ error: "CONFLICT", files: string[] }` if
conflict detected.

### `git_status`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cwd` | string | no | Working directory (default: project root) |

**Returns:** `{ modified, added, deleted, untracked }`

### `git_diff`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `files` | string[] | no | Files to diff (default: all) |
| `ref1` | string | no | First ref for comparison |
| `ref2` | string | no | Second ref for comparison |

**Returns:** `{ diff }`

### `git_log`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `n` | number | no | 10 | Number of commits |
| `branch` | string | no | current | Branch to show |

**Returns:** `{ commits: [{ sha, message, author, date }] }`

Also exposes `git_create_branch`, `git_checkout`, `git_merge`,
`git_delete_branch` for full branch lifecycle.

### Conflict handling

Conflicts are rare (conventions prevent agents from touching each other's
files) but possible. When `git_commit` returns a conflict:

- The agent reports it as a task failure.
- The Manager creates a resolution task or escalates.
- See [runtime/details](../runtime/details) for edge cases.

## 4. Data

**Origin:** builtin · **Implementation:** `src/mcp/builtins.ts` (in-process)

The current web-facing tools live in the **data** service, not the legacy
`web` stub. The data service supports public web search, bounded text
fetches, HTML-to-text extraction, downloads with provenance, fallback
downloads, and HEAD metadata. The separate `web` service is registered as
`available: false` with stub tools `fetch_url` / `fetch_page_content`, so
agent tool schemas do not include it.

### `web_search`

Search DuckDuckGo HTML results and return candidate URLs and snippets.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | — | Search query |
| `max_results` | number | no | `mcp.webSearchMaxResults` | Clamped to the configured ceiling (max 50) |

**Returns:** `{ query, results, status, skipped }`

**Error codes:** `INVALID_ARGUMENT`, `TIMEOUT`, `NETWORK_ERROR`,
`UPSTREAM_HTTP_ERROR`, `RESPONSE_TOO_LARGE`, `PARSE_FAILURE`,
`NO_RESULTS_PARSED`.

### `fetch_url`

Fetch a public HTTP(S) URL as bounded text.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | yes | — | Valid `http:` or `https:` URL |
| `max_bytes` | number | no | `mcp.maxFetchBytes` | Raw response byte cap, clamped between 1,000 and 1,000,000 |

**Returns:** `{ url, status, ok, headers, content, bytes_read, truncated }`

### `fetch_page_text`

Fetch an HTML page and return stripped readable text.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | yes | — | Valid `http:` or `https:` URL |
| `max_bytes` | number | no | `mcp.maxFetchBytes` | Raw HTML byte cap before stripping |

**Returns:** `{ url, status, ok, headers, text, bytes_read, truncated }`

### `download_file`

Download a public HTTP(S) artifact to a project-relative path.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | yes | — | Source URL |
| `path` | string | yes | — | Project-relative output path |
| `max_bytes` | number | no | `mcp.maxDownloadBytes` | Download cap, clamped up to 2 GiB |
| `headers` | object | no | — | Optional request headers |

**Returns:** `{ url, path, bytes, sha256, headers, attempts }`

### `download_with_fallbacks`

Try multiple source URLs with bounded retries and save the first successful
artifact.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `urls` | string[] | yes | — | Candidate URLs in preference order |
| `path` | string | yes | — | Project-relative output path |
| `max_bytes` | number | no | `mcp.maxDownloadBytes` | Download cap |
| `retries_per_url` | number | no | 2 | Clamped to 1..5 |
| `headers` | object | no | — | Optional headers for every candidate |
| `manifest_path` | string | no | — | Optional project-relative JSON attempt manifest |

**Returns:** successful download metadata plus `selected_url`, or an
`ALL_SOURCES_FAILED` envelope with the attempt log.

### `head_url`

Fetch response metadata without downloading the full body.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | yes | Valid `http:` or `https:` URL |

**Returns:** `{ url, status, ok, headers }`

## 5. Plan

**Origin:** builtin · **Source:** `src/mcp/plan-server.ts` ·
**Full specification:** [plan-service](./plan-service)

Manages `plan.json`, including embedded plan history. All reads and writes
go through this service — no agent touches the file directly.

| Tool | Description | Mutating |
|------|-------------|----------|
| `plan_get()` | Read the current plan | no |
| `plan_get_stage(stage_id)` | Look up a stage (active or history) | no |
| `plan_get_current_stage()` | Get the currently executing stage | no |
| `plan_set_stages(stages, current_stage_id)` | Replace the plan's stage list | yes |
| `plan_add_stage(stage)` | Append a stage | yes |
| `plan_remove_stage(stage_id)` | Remove a stage | yes |
| `plan_set_current(stage_id)` | Mark a stage as executing | yes |
| `plan_complete_stage(stage_id, result, summary, actual_outcomes, escalation?, abort_reason?)` | Archive stage to history | yes |
| `plan_get_history(last_n?)` | Read plan history | no |
| `plan_init(stages?)` | Initialize empty plan | yes |
| `plan_commit(message)` | Commit plan files to git | yes |
| `plan_done(reason)` | Signal verified project completion | no |

**Atomicity:** all writes use temp-file + rename. Schema validation on
every write. Error codes: `PLAN_NOT_FOUND`, `STAGE_NOT_FOUND`,
`STAGE_EXISTS`, `VALIDATION_ERROR`, `IO_ERROR`.

## 6. Skills

**Origin:** builtin · **Implementation:** `src/mcp/knowledgeSkills.ts`,
registered from `src/mcp/builtins.ts` over the SQLite sidecar-backed
knowledge lifecycle.

Skills are eagerly injected into agent system prompts; see
[knowledge/skills-and-memory](../knowledge/skills-and-memory) for the
canonical tool surface and the retrieval algorithm.

All write tools require a non-empty `reason` (`EMPTY_REASON` on violation)
and write the record mutation plus audit row inside a sidecar transaction.
The handler requires `ToolCallContext`, resolves `ctx.role`, and gates
operations through `permissions.canCall`.

| Tool | Purpose | Handler ACL | Notes |
|------|---------|-------------|-------|
| `create_skill` | Create a new skill record | Manager | Inputs: `{ name, description, body, triggers[]?, target_agents?, scope, scope_ref?, expires_at?, ttl_ms?, survive_compaction?, reason }`. Rejects `NAME_COLLISION` within scope. Not advertised by the current role filters. |
| `update_skill` | Mutate description / body / triggers / target_agents / TTL | Manager | Inputs: `{ id, body?, description?, triggers?, target_agents?, expires_at?, ttl_ms?, reason }`. Not advertised by the current role filters. |
| `supersede_skill` | Replace an active record with a new one | Manager, Inspector | Inputs: `{ old_id, new_record, reason }`. Worker-filter roles see this tool in the current advertised surface; only Manager succeeds. Inspector is handler-authorized but not currently advertised this mutation tool. |
| `archive_skill` | Mark `active` -> `archived` | Manager, Inspector | Inputs: `{ id, reason }`. |
| `delete_skill` | Hard-delete a skill record + body | Manager, Inspector | Inputs: `{ id, reason }`. |
| `list_skills` | Enumerate records | all roles | Inputs: `{ scope?, target_agent?, include_archived?, include_superseded? }`. |
| `read_skill` | Read full record + body | all roles | Inputs: `{ id }`. Returns the redacted read view. |
| `search_skills` | Full-text search active skills | all roles | Inputs: `{ query, scope?, limit? }`. Current role filters advertise it to worker-filter roles and Librarian. |

**Triggers.** `SkillRecord.triggers` is currently an array of strings; the
schema does not enforce a `keyword:` / `tag:` / `agent:` grammar. Built-in
skill frontmatter must still declare `target_agents` explicitly, with
`[]` meaning global.

**Origin & built-ins.** `SkillRecord.origin` is `"builtin"` for bundled
skills and `"project"` for runtime-authored records. `initKnowledgeStore()`
calls `upsertBuiltinSkills()` at boot, which parses bundled
`skills/builtin/**/SKILL.md` files and stores deterministic `builtin:<slug>`
rows in `.saivage/knowledge/store.sqlite`. The eager loader reads active
skill and memory rows from that sidecar; it no longer scans an on-disk
`SKILL.md` tree for injection candidates.

## 7. Memory

**Origin:** builtin · **Implementation:** `src/mcp/knowledgeMemory.ts`,
registered from `src/mcp/builtins.ts` over the same sidecar lifecycle as
Skills.

Memories are on-demand lookup (or eager when `target_agents` is
non-empty); see [knowledge/skills-and-memory](../knowledge/skills-and-memory)
for the canonical tool surface and the retrieval algorithm.

| Tool | Purpose | Handler ACL | Notes |
|------|---------|-------------|-------|
| `create_memory` | Create a new memory record | Planner, Manager, Coder, Researcher, Inspector, Librarian | Inputs: `{ topic, keys[]?, body, target_agents?, scope, scope_ref?, expires_at?, ttl_ms?, survive_compaction?, source_ref?, reason }`. Coder/Researcher are restricted to current-stage scope. Librarian is restricted to project scope and `rag/{policy|secret-incidents|drift-incidents}` topics. |
| `update_memory` | Mutate body / keys / target_agents / TTL | Planner, Manager, Coder, Researcher, Inspector, Librarian | Inputs: `{ id, body?, keys?, target_agents?, expires_at?, ttl_ms?, reason }`. Same scope/topic restrictions as `create_memory`. |
| `supersede_memory` | Replace an active record | Planner, Manager, Inspector | Inputs: `{ old_id, new_record, reason }`. |
| `archive_memory` | Mark `active` -> `archived` | Planner, Manager, Inspector | Inputs: `{ id, reason }`. |
| `delete_memory` | Hard-delete a memory record | Planner, Manager, Inspector | Inputs: `{ id, reason }`. |
| `list_memories` | Enumerate records | all roles except Data Agent | Inputs: `{ scope?, topic_domain?, include_archived?, older_than_days? }`. |
| `get_memory` | Read by id OR by topic; walks supersession chain to head | all roles except Data Agent | Inputs: `{ id }` OR `{ topic: {domain, subject, aspect?} }`. Returns `NOT_FOUND` when no active memory is found. |
| `search_memories` | Full-text search active memories | all roles except Data Agent | Inputs: `{ query, scope?, limit? }`. Current role filters advertise it to worker-filter roles and Librarian; handler ACL still denies Data Agent. |

**Chat has no memory write tools.** `/remember <text>` is an inter-agent
message to Planner; Planner decides whether to call `create_memory`.

**TTL / decay.** Records may store `ttl_ms` / `expires_at`, and lifecycle
states include `expired`, but the current lifecycle code does not include
a live sweeper that automatically archives or expires records by scope.

## 8. RAG

**Origin:** builtin · **Implementation:** `src/server/rag/handler.ts`,
registered from `src/mcp/builtins.ts` when bootstrap constructs a
`RagService`.

The RAG service is an in-process façade over the semantic collection
manager. Bootstrap initializes the service with `adminRoles: ["librarian"]`;
admin-scope calls also succeed from runtime operator context. If RAG is
disabled, every RAG tool returns a `RAG_DISABLED` envelope.

| Tool | Purpose | Inputs | Handler ACL |
|------|---------|--------|-------------|
| `rag_list` | List registered collections | `{}` | Any advertised caller |
| `rag_stats` | Read stats for a collection | `{ collection_id }` | Any advertised caller |
| `rag_query` | Semantic search a collection | `{ collection_id, text, topK?, filter? }` | Any advertised caller |
| `rag_register` | Register a collection | `{ collection_id, source, chunker, sources, provider?, exclusions?, watch?, persist? }` | Operator context or Librarian |
| `rag_ingest` | Ingest a collection | `{ collection_id }` | Operator context or Librarian |
| `rag_drop` | Drop a collection | `{ collection_id, persist? }` | Operator context or Librarian |
| `rag_admin` | Reconcile or arm/disarm watchers | `{ collection_id, action }` where action is `reconcile`, `watch_arm`, or `watch_disarm` | Operator context or Librarian |

`rag_register`, `rag_drop`, and `rag_admin` share a single-flight control
mutex and return `RAG_CONTROL_BUSY` when another control operation is in
progress. `rag_ingest` intentionally uses the collection manager's ingest
lock instead. All RAG tools return the RAG envelope shape; common error
codes include `RAG_UNAUTHORIZED_ROLE`, `RAG_INVALID_ARGS`, and mapped
manager / store failures.

## 9. Notes

**Origin:** builtin · **Implementation:** `src/mcp/notes-server.ts`
(in-process), registered by `src/server/bootstrap.ts`.

The Notes MCP service exposes one agent-facing tool. Runtime note listing,
Planner draining, and acknowledgment are handled by `NoteManager` and the
server API, not by separate MCP tools.

### `create_note`

Create a user note for the Planner.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `content` | string | yes | - | The user's direction / feedback |
| `permanent` | boolean | no | `false` | If `true`, note persists across Planner context resets |
| `urgent` | boolean | no | `false` | Marks the note high priority for the Planner; it does not interrupt running Planner or worker calls |
| `channel` | string | no | `chat` | Optional source channel name |
| `session_id` | string | no | `tool-create-note` | Optional source session id |

**Returns:** `{ id, urgent, permanent, path }`.

**Advertised to:** Chat and worker-filter roles (Manager, Coder,
Researcher, Data Agent, Designer). The current handler does not perform an
additional role check.

## 10. Agent dispatch

**Origin:** runtime · **Type:** in-process pseudo-tools — not a standalone
MCP service.

These schemas are added to the parent agent's LLM conversation from the
agent roster. They are handled directly by `Dispatcher`, not by an
external MCP process.

| Tool | Parent roles | Required input | Returns |
|------|--------------|----------------|---------|
| `run_manager` | Planner | `{ stage }` | `StageSummary` |
| `run_inspector` | Planner | `{ request }` | `InspectionReport` |
| `run_coder` | Manager | `{ task, stageId }` | `TaskReport` |
| `run_researcher` | Manager | `{ task, stageId }` | `TaskReport` |
| `run_data_agent` | Manager | `{ task, stageId }` | `TaskReport` |
| `run_reviewer` | Manager | `{ task, stageId }` | `TaskReport` |
| `run_designer` | Manager | `{ task, stageId }` | `TaskReport` |
| `run_critic` | Manager | `{ task, stageId }` | `TaskReport` |
| `run_librarian` | Planner, Manager | `{ objective }`, plus optional `collection_id` and `context` | Markdown report |

For worker dispatches, the dispatcher allows at most one concurrent call
per worker role in a single LLM response batch. Extra calls for the same
role are rejected with an error result.

## External services

The defaults include **Playwright** (browser automation) launched on
demand via `npx -y @playwright/mcp`. Add more under `mcpServers` in
`saivage.json` — see [mcp/runtime](./runtime).

## Tool catalog discovery

Agents see only the tools advertised by their role (`assembleTools()`).
The runtime's complete catalog can be inspected via:

```bash
curl -fsS http://127.0.0.1:8080/api/state | jq '.mcp.services'
```
