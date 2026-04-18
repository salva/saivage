# Saivage v2 — MCP Services

Complete catalog of MCP services available to v2 agents. Services are either **built-in** (shipped with Saivage, registered on startup) or **generated** (created at runtime by agents).

All services communicate via **stdio transport** using the MCP SDK. The runtime manages service lifecycle (lazy start, health checks, idle shutdown, crash recovery) through the `McpRuntime` class (carried from v1).

---

## Service Inventory

| Service | Origin | Transport | Purpose |
|---------|--------|-----------|---------|
| [Filesystem](#1-filesystem) | builtin | stdio | File read/write/search |
| [Shell](#2-shell) | builtin | stdio | Command execution |
| [Git](#3-git) | builtin | stdio | Version control (serialized) |
| [Web](#4-web) | builtin | stdio | HTTP fetch, page content extraction |
| [Plan](#5-plan) | builtin | stdio | Plan state management |
| [Skills](#6-skills) | builtin | stdio | Skill CRUD |
| [Memory](#7-memory) | builtin | stdio | Long-term key-value store |
| [Index](#8-index) | builtin | stdio | Full-text search across documents |
| [Agent Dispatch](#9-agent-dispatch) | runtime | in-process | Parent→child agent invocation |

---

## Agent → Service Access Matrix

Which agents can use which services. Convention-based — not enforced by the runtime (except Chat which is genuinely read-only for project state).

| Service | Planner | Manager | Coder | Researcher | Inspector | Chat |
|---------|---------|---------|-------|------------|-----------|------|
| Filesystem (read) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Filesystem (write) | — | ✓¹ | ✓ | ✓² | ✓ | — |
| Shell | — | — | ✓ | ✓ | ✓ | — |
| Git | ✓³ | ✓³ | ✓ | ✓ | ✓ | — |
| Web | — | — | ✓ | ✓ | ✓ | — |
| Plan (read) | ✓ | — | — | — | — | ✓ |
| Plan (write) | ✓ | — | — | — | — | — |
| Skills | — | — | ✓⁴ | — | — | — |
| Memory | — | — | ✓ | ✓ | ✓ | — |
| Index | — | — | ✓ | ✓ | ✓ | — |
| Agent Dispatch | ✓ | ✓ | — | — | — | ✓⁵ |

¹ Manager writes `tasks.json`, `summary.json` under `.saivage/stages/`.
² Researcher writes under `research/` by convention.
³ Planner/Manager use git only for `.saivage/` state files.
⁴ Coder creates skills via the skills service when tasked by the Manager.
⁵ Chat can only dispatch Inspector, not Manager/Coder/Researcher.

---

## 1. Filesystem

**Origin:** builtin (carried from v1)
**Source:** `src/services/filesystem/service.ts`

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

**Origin:** builtin (carried from v1)
**Source:** `src/services/shell/service.ts`

### Tools

#### `run_command`
Execute a shell command and return output.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | string | yes | — | Shell command to run |
| `cwd` | string | no | project root | Working directory |
| `timeout` | number | no | 60000 | Timeout in ms |

**Returns:** `{ stdout: string, stderr: string, exitCode: number }`

**Limits:** Output truncated at 100KB. Throws on timeout.

---

## 3. Git

**Origin:** builtin (adapted from v1)
**Source:** `src/services/git/service.ts`
**Dependency:** `simple-git`

All git operations are serialized through this single MCP server — no direct `git` CLI calls by agents. This eliminates race conditions and ensures atomic operations.

### Tools

#### `git_commit`
Stage specified files and commit.

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

**Origin:** builtin (carried from v1)
**Source:** `src/services/web/service.ts`
**Dependency:** `cheerio`

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
**Source:** `src/v2/mcp/plan-server.ts`
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

**Origin:** builtin (carried from v1, adapted for v2)
**Source:** `src/services/skills/service.ts`

### Tools

#### `list_skills`
List all available skills with metadata.

**Returns:** Array of `{ name, description, triggers, target_agents, scope, updated_at }`.

#### `read_skill`
Read full skill markdown content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Skill name |

**Returns:** `{ name: string, content: string }`

#### `create_skill`
Create a new skill file with YAML frontmatter.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | string | yes | — | Skill name (lowercase, hyphens) |
| `description` | string | yes | — | Human-readable summary |
| `content` | string | yes | — | Full markdown content with YAML frontmatter |
| `scope` | string | no | `"workspace"` | `"user"` (global) or `"workspace"` (project) |

**Returns:** `{ created: true, path: string }`

#### `update_skill`
Update an existing skill.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Skill name |
| `content` | string | yes | New content |
| `reason` | string | yes | Why the update was made |

**Returns:** `{ updated: true }`

### Discovery Paths (precedence order)
1. `<SAIVAGE_ROOT>/skills/` — builtin skills shipped with Saivage
2. `~/.saivage/skills/` — user global skills
3. `<PROJECT>/.saivage/skills/` — project-specific skills (highest precedence)

### v2 Adaptation
- Add `target_agents` to frontmatter (v1 had `agentTypes`)
- Add `agent:<type>` trigger type
- Skill loading applies to all agent types, not just workers

---

## 7. Memory

**Origin:** builtin (carried from v1)
**Source:** `src/services/memory/service.ts`
**Storage:** SQLite with FTS5 (`~/.saivage/data/memory.db`)

Long-term key-value store with full-text search. Used by agents to persist knowledge across sessions.

### Tools

#### `store`
Store a key-value pair.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | string | yes | — | Unique key |
| `value` | string | yes | — | Content to store |
| `tags` | string[] | no | `[]` | Categorization tags |

**Returns:** `{ stored: true }`

Upserts — overwrites if key exists.

#### `recall`
Recall by exact key or full-text search.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | string | no | — | Exact key lookup |
| `query` | string | no | — | Full-text search |
| `limit` | number | no | 10 | Max results |

One of `key` or `query` must be provided.

**Returns:** `{ results: [{ key, value, tags, createdAt, updatedAt }] }`

#### `list`
List memory keys, optionally filtered by tag.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `tag` | string | no | — | Filter by tag |
| `limit` | number | no | 50 | Max results |

**Returns:** `{ keys: [{ key, tags, updatedAt }] }`

#### `delete`
Delete a memory entry.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | yes | Key to delete |

**Returns:** `{ deleted: boolean }`

---

## 8. Index

**Origin:** builtin (carried from v1)
**Source:** `src/services/index/service.ts`
**Storage:** SQLite with FTS5 (`~/.saivage/data/index.db`)

Full-text search index for project documents (conversations, work items, files, notes).

### Tools

#### `ingest`
Index a document for search.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | string | yes | — | Unique document ID |
| `type` | string | yes | — | `"conversation"`, `"work"`, `"file"`, or `"note"` |
| `title` | string | no | `""` | Document title |
| `content` | string | yes | — | Full text content |
| `metadata` | object | no | `{}` | Arbitrary metadata |

**Returns:** `{ indexed: true }`

Upserts — re-indexes if ID exists.

#### `search`
Full-text search across all document types.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | — | Search query |
| `type` | string | no | — | Filter by document type |
| `limit` | number | no | 10 | Max results |

**Returns:** `{ results: [{ id, type, title, snippet, metadata, createdAt }] }`

Snippets are truncated to 200 characters.

#### `search_conversations`
Convenience — search only conversation documents.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | — | Search query |
| `limit` | number | no | 10 | Max results |

#### `search_work`
Convenience — search only work-item documents.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | — | Search query |
| `limit` | number | no | 10 | Max results |

---

## 9. Agent Dispatch

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
- Are registered in `~/.saivage/registry.json` with `origin: "generated"`.
- Follow the same stdio transport protocol.
- Are auto-discovered on next startup.
- Can be created to wrap external APIs, data sources, or project-specific tooling.

The scaffold generates: `package.json`, `tsconfig.json`, `src/index.ts` (MCP server template), and `src/index.test.ts`.
