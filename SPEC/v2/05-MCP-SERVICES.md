# Saivage v2 — MCP Services

Complete catalog of MCP services available to v2 agents. Services are either **built-in** (shipped with Saivage, registered on startup) or **generated** (created at runtime by agents).

Core services (filesystem, shell, git, skills, plan) run **in-process** — direct function calls inside the Node.js process, no subprocess overhead. Services that need external dependencies not yet integrated (web, memory, index, lock) are registered as stubs that return an error if called.

The MCP runtime manages service lifecycle through the `McpRuntime` class.

---

## Service Inventory

| Service | Origin | Transport | Purpose |
|---------|--------|-----------|---------|
| [Filesystem](#1-filesystem) | builtin | in-process | File read/write/search |
| [Shell](#2-shell) | builtin | in-process | Command execution |
| [Git](#3-git) | builtin | in-process | Version control |
| [Web](#4-web) | builtin | stub | HTTP fetch, page content extraction |
| [Plan](#5-plan) | builtin | in-process | Plan state management |
| [Skills](#6-skills) | builtin | in-process | Skill records: CRUD + lifecycle + search |
| [Memory](#7-memory) | builtin | in-process | Memory records: CRUD + lifecycle + topic/keyword retrieval |
| [Agent Dispatch](#8-agent-dispatch) | runtime | in-process | Parent→child agent invocation |

---

## Agent → Service Access Matrix

Which agents can use which services. The Filesystem / Shell / Git / Web / Plan / Agent-Dispatch rows are convention-based (except Chat, which is genuinely read-only for project state). **The Skills and Memory rows are enforced** by the MCP runtime via `ToolCallContext` + `permissions.canCall` / `checkScope` at the runtime entry point (`src/mcp/runtime.ts`), not by handler convention. Unauthorized calls return `UNAUTHORIZED_ROLE` or `UNAUTHORIZED_SCOPE`.

| Service | Planner | Manager | Coder | Researcher | Data Agent | Inspector | Reviewer | Designer | Chat |
|---------|---------|---------|-------|------------|------------|-----------|----------|----------|------|
| Filesystem (read) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Filesystem (write) | — | ✓¹ | ✓ | ✓² | — | ✓ | — | — | — |
| Shell | — | — | ✓ | ✓ | ✓ | ✓ | — | — | — |
| Git | ✓³ | ✓³ | ✓ | ✓ | — | ✓ | — | — | — |
| Web | — | — | ✓ | ✓ | — | ✓ | — | — | — |
| Plan (read) | ✓ | — | — | — | — | — | — | — | ✓ |
| Plan (write) | ✓ | — | — | — | — | — | — | — | — |
| Skills | see §6 / design §F | see §6 | see §6 | see §6 | see §6 | see §6 | see §6 | see §6 | see §6 |
| Memory | see §7 / design §F | see §7 | see §7 | see §7 | see §7 | see §7 | see §7 | see §7 | see §7 |
| Agent Dispatch | ✓ | ✓ | — | — | — | — | — | — | ✓⁴ |

¹ Manager writes `tasks.json`, `summary.json` under `.saivage/stages/`.
² Researcher writes under `research/` by convention.
³ Planner/Manager use git only for `.saivage/` state files.
⁴ Chat can only dispatch Inspector, not Manager/Coder/Researcher.

**Skills + Memory ACL.** The full 9-role × per-operation matrix (create / update / supersede / archive / delete / list / read / search, split by kind) is the authoritative source in [SPEC/v2/skills-memory/01-DESIGN.md](skills-memory/01-DESIGN.md) §F. Key facts:

- **Skill writes** (create / update / supersede / archive / delete): **Manager** and **Inspector** only. All other roles are denied with `UNAUTHORIZED_ROLE`.
- **Memory writes**: Planner, Manager, Inspector own the full lifecycle (including supersede/archive). Coder/Researcher may `create_memory` / `update_memory` **only** with `scope == "stage"` and `scope_ref == <current stage_id>`; any other scope returns `UNAUTHORIZED_SCOPE`. Promotion to `project` requires Inspector or Manager `supersede_memory` (see §B.5 allowed-pairs table).
- **Reads** (`list_*`, `read_skill`, `get_memory`, `search_*`): every role except Data Agent for memory; Data Agent is skill-only. Worker roles (Coder/Researcher/Reviewer/Designer/Data Agent) honour `target_agents` on reads; Inspector and Chat are privileged readers and see all values.
- **Chat has NO write tools.** `/remember` / `/forget` are inter-agent messages to Planner (design §H.1); Planner decides whether to call `create_memory` / `archive_memory`.

---

## 1. Filesystem

**Origin:** builtin
**Implementation:** `src/mcp/builtins.ts` (in-process)

### Tools

#### `read_file`
Read the complete contents of a file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute or project-relative file path |

**Returns:** `{ content: string }` or error if file not found.

#### `write_file`
Write content to a file. Creates parent directories if needed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | File path |
| `content` | string | yes | Full file content |

**Returns:** `{ written: true, path: string }`

#### `list_dir`
List directory contents with type indicators.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Directory path |

**Returns:** `{ entries: [{ name, type: "file"|"dir" }] }`

#### `search_files`
Search for files matching a glob pattern.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `directory` | string | yes | Root directory to search |
| `pattern` | string | yes | Glob pattern (e.g., `**/*.ts`) |

**Returns:** `{ files: string[] }` — matching file paths.

---

## 2. Shell

**Origin:** builtin
**Implementation:** `src/mcp/builtins.ts` (in-process)

### Tools

#### `run_command`
Execute a shell command and return output.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | string | yes | — | Shell command to run |
| `cwd` | string | no | project root | Working directory |
| `timeout_ms` | number | no | none | Hard wall-clock timeout in ms; `0` disables |
| `timeout` | number | no | none | Deprecated alias for `timeout_ms` |
| `inactivity_timeout_ms` | number | no | none | No-output-growth timeout in ms; terminates when stdout/stderr log files do not grow for this long; `0` disables |
| `idle_timeout_ms` | number | no | none | Deprecated alias for `inactivity_timeout_ms` |
| `stdout_path` | string | no | auto | Project-relative file path for full stdout log |
| `stderr_path` | string | no | auto | Project-relative file path for full stderr log |

**Returns:** `{ stdout: string, stderr: string, exitCode: number, stdout_path: string, stderr_path: string, stdout_bytes: number, stderr_bytes: number, started_at: string, completed_at: string, duration_ms: number, last_output_at: string | null }`

**Limits:** Full output is written to project-local log files. Returned `stdout`/`stderr` are capped tails of those logs. Timeouts return `exitCode: 124` and include the timeout reason in `stderr`, including the last observed output timestamp for inactivity timeouts. Long-running commands should emit periodic stdout/stderr and set `inactivity_timeout_ms` when no log growth means the process is unhealthy.

---

## 3. Git

**Origin:** builtin
**Implementation:** `src/mcp/builtins.ts` (in-process, uses `git` CLI directly)

All git operations are serialized through this single service — no direct `git` CLI calls by agents. This eliminates race conditions and ensures atomic operations.

### Tools

#### `git_commit`
Stage specified files and commit.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `files` | string[] | yes | — | Files to stage (relative to project root) |
| `message` | string | yes | — | Commit message |
| `task_id` | string | no | — | If provided, message is prefixed with `[tsk-<id>]` |

**Returns:** `{ sha: string }` or `{ error: "CONFLICT", files: string[] }` if conflict detected.

**v2 change from v1:** The v1 `commit` tool staged all files (`["."]`). V2 requires explicit file lists to enforce per-agent commit scoping.

#### `git_status`
Show working tree status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cwd` | string | no | Working directory (default: project root) |

**Returns:** `{ modified: string[], added: string[], deleted: string[], untracked: string[] }`

#### `git_diff`
Show diff of specified files or all changes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `files` | string[] | no | Files to diff (default: all) |
| `ref1` | string | no | First ref for comparison |
| `ref2` | string | no | Second ref for comparison |

**Returns:** `{ diff: string }`

#### `git_log`
Show recent commit log.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `n` | number | no | 10 | Number of commits |
| `branch` | string | no | current | Branch to show |

**Returns:** `{ commits: [{ sha, message, author, date }] }`

### Conflict Handling

Conflicts are rare (conventions prevent agents from touching each other's files) but possible. When `git_commit` returns a conflict:
- The agent reports it as a task failure.
- The Manager creates a resolution task or escalates.
- See [04-RUNTIME-DETAILS.md](04-RUNTIME-DETAILS.md) §11 for edge cases.

---

## 4. Web

**Origin:** builtin (stub — not yet implemented)
**Implementation:** `src/mcp/builtins.ts` (stub handler)

> **Note:** This service is registered but not yet functional. Calls return a descriptive error. A future implementation will use Playwright or a similar library.

### Tools

#### `fetch_url`
Fetch raw URL content.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | yes | — | Valid URL |
| `headers` | object | no | `{}` | Additional HTTP headers |
| `maxBytes` | number | no | 102400 | Max response size (100KB) |

**Returns:** `{ status: number, contentType: string, body: string, truncated: boolean }`

**Limits:** 30-second timeout. User-Agent: `Saivage/0.1.0`.

#### `fetch_page_content`
Fetch a web page and extract readable text content (HTML stripped).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | yes | — | Valid URL |
| `selector` | string | no | `"body"` | CSS selector for content extraction |
| `maxLength` | number | no | 51200 | Max content length (50KB) |

**Returns:** `{ title: string, url: string, content: string, truncated: boolean }`

Noise elements (scripts, styles, nav, ads) are automatically removed.

---

## 5. Plan

**Origin:** builtin (new in v2)
**Source:** `src/mcp/plan-server.ts`
**Full specification:** [03-PLAN-MCP-SERVICE.md](03-PLAN-MCP-SERVICE.md)

Manages `plan.json` and `plan-history.json`. All reads and writes go through this service — no agent touches these files directly.

### Tools

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

**Atomicity:** All writes use temp-file + rename. Schema validation on every write.
**Error codes:** `PLAN_NOT_FOUND`, `STAGE_NOT_FOUND`, `STAGE_EXISTS`, `VALIDATION_ERROR`, `IO_ERROR`.

---

## 6. Skills

**Origin:** builtin
**Implementation:** `src/mcp/builtins.ts` thin handlers over `src/knowledge/store.ts` (`writeRecordAtomic` + `appendJsonlAtomic` + `rebuildIndex`).

Skills are eagerly injected into agent system prompts; see [SPEC/v2/skills-memory/01-DESIGN.md](skills-memory/01-DESIGN.md) §C.1 for the canonical tool surface and §D for the retrieval algorithm.

All write tools require a non-empty `reason` (`EMPTY_REASON` on violation) and append exactly one `AuditEntry` to the scope's `audit.jsonl` (design §C.3). Authorization is enforced at the MCP runtime via `ToolCallContext` + `permissions.canCall`.

### Tools

| Tool | Purpose | Callable by | Notes |
|------|---------|-------------|-------|
| `create_skill` | Create a new skill record | Manager, Inspector | Inputs: `{ name, description, body, triggers[]?, target_agents[], scope, scope_ref?, expires_at?, ttl_ms?, survive_compaction?, reason }`. Rejects `NAME_COLLISION` within scope. |
| `update_skill` | Mutate description / body / triggers / target_agents / TTL | Manager, Inspector | Inputs: `{ id, body?, description?, triggers?, target_agents?, expires_at?, ttl_ms?, reason }`. |
| `supersede_skill` | Replace an active record with a new one; widens scope only | Manager, Inspector | Inputs: `{ old_id, new_record, reason }`. Two-record atomic write; rejects `INVALID_SUPERSEDE_TARGET` / `INVALID_SUPERSEDE_SCOPE`. |
| `archive_skill` | Mark `active` → `archived` (reversible) | Manager, Inspector | Inputs: `{ id, reason }`. |
| `delete_skill` | Tombstone + audit | Manager, Inspector | Inputs: `{ id, reason }`. |
| `list_skills` | Enumerate summaries | all roles | Inputs: `{ scope?, target_agent?, include_archived?, include_superseded? }`. Returns the per-scope `index.json` projection. |
| `read_skill` | Read full record + body | all roles | Inputs: `{ id }`. Returns `{ record, body }`. Re-scans body for secrets on read (design §C.3 Security). |
| `search_skills` | Keyword search over triggers + name + description + body snippet | all roles | Inputs: `{ query, scope?, limit? }`. Canonical normalization (NFC + lower + strip-punct + collapse-ws); stable ordering score → updated_at → id. |

**Triggers.** Only `keyword:<word>`, `tag:<label>`, `agent:<role>` are valid. `tool:` and `path:` are removed from `SkillRecord.triggers` validation (design §D.4). Triggerless skills are allowed (FR-8): they are never eager-injected but participate in `search_skills` and `read_skill` by id.

**Origin & built-ins.** `SkillRecord.origin` is `"builtin"` for skills shipped at `saivage/skills/builtin/<topic>/SKILL.md` (bundled into `dist/skills/builtin/` by `tsup`), or `"project"` for skills authored at runtime under `<project>/.saivage/skills/{project,stages/<id>,sessions/<id>}/`. Built-ins are walked by `src/knowledge/builtinWalker.ts` and projected into the eager-injection candidate set with `origin="builtin"`, `scope="project"`. They have no `index.json`.

**Generic filesystem writes targeted at `.saivage/{skills,memory}/` are rejected by `fsGuard`** from any role — the MCP surface is the only authoring path (closes FA §1.6.4 escape hatch).

Error taxonomy: see design §C.3.

---

## 7. Memory

**Origin:** builtin
**Implementation:** `src/mcp/builtins.ts` thin handlers over the same `src/knowledge/store.ts` primitives as Skills.

Memories are on-demand lookup (or eager when `target_agents` is non-empty); see [SPEC/v2/skills-memory/01-DESIGN.md](skills-memory/01-DESIGN.md) §C.1 for the canonical tool surface and §D for the retrieval algorithm.

### Tools

| Tool | Purpose | Callable by | Notes |
|------|---------|-------------|-------|
| `create_memory` | Create a new memory record | Planner, Manager, Coder, Researcher, Inspector | Inputs: `{ topic, keys[]?, body, target_agents[], scope, scope_ref?, expires_at?, ttl_ms?, survive_compaction?, source_ref?, reason }`. Coder/Researcher are restricted to `scope == "stage"` (otherwise `UNAUTHORIZED_SCOPE`). Rejects `TOPIC_COLLISION` within scope. |
| `update_memory` | Mutate body / keys / target_agents / TTL | Planner, Manager, Coder, Researcher, Inspector | Inputs: `{ id, body?, keys?, target_agents?, expires_at?, ttl_ms?, reason }`. Same worker-scope restriction as `create_memory`. |
| `supersede_memory` | Replace an active record; widens scope only | Planner, Manager, Inspector | Inputs: `{ old_id, new_record, reason }`. Two-record atomic write. |
| `archive_memory` | Mark `active` → `archived` (reversible) | Planner, Manager, Inspector | Inputs: `{ id, reason }`. |
| `delete_memory` | Tombstone + audit | Planner, Manager, Inspector | Inputs: `{ id, reason }`. |
| `list_memories` | Enumerate summaries | Planner, Manager, Inspector, Reviewer, Chat | Inputs: `{ scope?, topic_domain?, include_archived?, older_than_days? }`. `older_than_days` powers Inspector stale-evidence review (FR-19). |
| `get_memory` | Read by id OR by topic; walks supersession chain to head | all roles except Data Agent | Inputs: `{ id }` OR `{ topic: {domain, subject, aspect?} }`. Looks up in `memory/project`, `memory/stages/<ctx.stage_id>`, `memory/sessions/<ctx.channel_id>`; most-specific-scope wins. Returns `null` when chain head is not `active` (caller may pass `include_history: true`). |
| `search_memories` | Keyword search over topic + keys + body snippet | all roles except Data Agent | Inputs: `{ query, scope?, limit? }`. Canonical normalization identical to `search_skills`; scoring weights: 3× topic, 2× keys, 1× body snippet. |

**Chat has no memory write tools.** `/remember <text>` is an inter-agent message to Planner; Planner decides whether to call `create_memory` (design §H.1).

**TTL / decay.** Project-scope memories may set `ttl_ms` / `expires_at`; stage/session scopes ignore TTL (lifecycle hooks archive them on stage terminate / channel close). The sweeper transitions `active → expired` on-load under the per-record mutex (design §G.2).

Error taxonomy: see design §C.3.

---

## 8. Agent Dispatch

**Origin:** runtime (new in v2)
**Type:** In-process pseudo-tools — not a standalone MCP service

These are registered as tools on the parent agent's LLM conversation. They are handled directly by the runtime, not by an external MCP process.

### Tools

#### `run_manager`
Dispatch a stage to the Manager agent. The calling agent (Planner) suspends until the Manager completes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `stage` | Stage | yes | Full Stage object from the plan |

**Returns:** `StageSummary` — the Manager's completion report.

**Available to:** Planner only.

#### `run_coder`
Dispatch a coding/testing/documentation task to the Coder agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | Task | yes | Full Task object including description, checklist, attempt |

**Returns:** `TaskReport` — the Coder's completion report.

**Available to:** Manager only.

#### `run_researcher`
Dispatch a research task to the Researcher agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | Task | yes | Full Task object including description, checklist, attempt |

**Returns:** `TaskReport` — the Researcher's completion report.

**Available to:** Manager only.

#### `run_inspector`
Dispatch an investigation to the Inspector agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `request` | InspectionRequest | yes | Investigation scope and questions |

**Returns:** `InspectionReport` — the Inspector's analysis report.

**Available to:** Planner, Chat.

#### `create_note`
Create a user note for the Planner.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `content` | string | yes | — | The user's direction/feedback |
| `permanent` | boolean | no | `false` | If `true`, note persists across replans as a lasting objective modifier |
| `urgent` | boolean | no | `false` | If `true`, aborts active agents and forces immediate replan |

**Returns:** `{ note_id: string, created: true }`

**Available to:** Chat only.

---

## v1 Services Not Carried to v2

| v1 Service | Reason |
|------------|--------|
| **Lock** | v2 serializes access through the MCP runtime (one tool call at a time). Convention-based territory replaces explicit locking. |
| **Orchestrator (in-process)** | v1's orchestrator tools (`orch_*`) are replaced by the Plan MCP service + agent dispatch tools. |

---

## Service Lifecycle

Managed by `McpRuntime` (carried from v1):

1. **Lazy start**: services are started on first tool call, not on boot.
2. **Health checks**: periodic ping (configurable interval). Dead services are restarted.
3. **Idle shutdown**: services unused for a configurable period are stopped to free resources.
4. **Crash recovery**: if a service process dies, it is restarted on next tool call (crash count tracked).
5. **In-process services**: agent dispatch tools run in-process — no subprocess overhead.

---

## Generated Services

Agents (primarily Coder, directed by Manager) can **generate new MCP services** at runtime using the scaffold system from v1 (`src/generator/scaffold.ts`). Generated services:
- Are registered in `<project>/.saivage/registry.json` with `origin: "generated"`.
- Follow the same stdio transport protocol.
- Are auto-discovered on next startup.
- Can be created to wrap external APIs, data sources, or project-specific tooling.

The scaffold generates: `package.json`, `tsconfig.json`, `src/index.ts` (MCP server template), and `src/index.test.ts`.
