# MCP Services Catalog

[`src/mcp/builtins.ts`](https://github.com/salva/saivage/blob/main/src/mcp/builtins.ts) ·
spec [`SPEC/v2/05-MCP-SERVICES.md`](https://github.com/salva/saivage/blob/main/SPEC/v2/05-MCP-SERVICES.md)

The built-in services that ship with Saivage. All run in-process unless
noted. The plan service has its own page: [Plan MCP Service](./plan-mcp).

## Filesystem (`fs`)

| Tool | Purpose |
|------|---------|
| `read_file` | Read a file (UTF-8). Length-capped. |
| `write_file` | Atomic write (temp + rename). |
| `list_dir` | Directory listing with file/directory flags. |
| `search_files` | Recursive substring or regex search. |

The handler enforces a project-root sandbox by `path.resolve` + prefix
check; absolute paths outside the project root are rejected.

## Shell (`shell`)

| Tool | Purpose |
|------|---------|
| `run_command` | Execute a command in a project subdirectory. |

Commands run with the daemon's environment, with `PROJECT_ROOT` injected.
Stdout/stderr are captured (truncated to a configured byte limit) and
returned as the tool result. There is **no** allow-list — sandboxing is
the job of the LXC container.

## Git (`git`)

| Tool | Purpose |
|------|---------|
| `git_status` | Working-tree status. |
| `git_create_branch` | Create + checkout a branch. |
| `git_checkout` | Checkout a ref. |
| `git_commit` | Stage given files & commit (with message + task_id). |
| `git_merge` | Merge a branch. |
| `git_diff` | Diff (optional file/ref filters). |
| `git_delete_branch` | Delete a branch. |
| `git_log` | Recent log. |

Workers commit through these tools; the runtime never invokes `git
commit` directly outside the abort flow's `git checkout -- .`.

## Plan (`plan`)

12 tools — see [Plan MCP Service](./plan-mcp).

## Notes (`notes`)

| Tool | Purpose |
|------|---------|
| `create_note` | Create a user note (channel context filled by runtime). |
| `list_notes` | Read pending notes. |
| `acknowledge_note` | Mark a note acknowledged. |

The `create_note` tool is the only mutation surface available to the Chat
agent.

## Skills (`skills`)

| Tool | Purpose |
|------|---------|
| `list_skills` | List available skills. |
| `read_skill` | Fetch a skill by name. |
| `create_skill` | Create a new skill (Markdown + index entry). |
| `update_skill` | Update an existing skill. |

## Web (stub by default)

| Tool | Purpose |
|------|---------|
| `fetch_url` | Raw URL fetch. |
| `fetch_page_content` | Fetch + extract text. |
| `web_search` | Search engine wrapper (provider-dependent). |
| `download_file` | Download to a path. |

The implementations are present but registered as **available** only when
the daemon is configured with the requisite providers; otherwise the
service is registered as a stub so the catalog remains discoverable.

## Memory (stub)

`store_memory`, `recall_memory`, `list_memories`, `delete_memory` — keyed
key-value scratch store. Currently stub; designed for future durable
memory backends.

## Index (stub)

`index_ingest`, `index_search` — full-text search across project content.
Stubbed pending integration with a search engine.

## Lock (stub)

`lock_acquire`, `lock_release`, `lock_status`, `lock_list` — advisory
locks for coordinating multiple agent threads on shared resources.

## External services

The defaults include **Playwright** (browser automation) launched on
demand via `npx -y @playwright/mcp`. Add more under `mcpServers` in
`saivage.json` — see [MCP Runtime](./mcp-runtime).

## Tool catalog discovery

The agents see only the tools advertised by their role
(`assembleTools()`). The runtime's complete catalog can be inspected
via:

```bash
curl -fsS http://127.0.0.1:8080/api/state | jq '.mcp.services'
```
