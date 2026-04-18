# Saivage — Reusable Code & Patterns from Open Source

Research synthesis from OpenClaw, GitHub Copilot/VSCode, official MCP servers,
and the broader MCP ecosystem.

---

## 1. Direct MCP Server Replacements

Saivage has 7 built-in services. Several can be **replaced outright** with
battle-tested official reference servers from `modelcontextprotocol/servers`:

| Saivage Service | Replace With | Package | Benefit |
|---|---|---|---|
| `filesystem` (162 LOC) | **@modelcontextprotocol/server-filesystem** | `npx -y @modelcontextprotocol/server-filesystem` | Configurable allowlists, symlink handling, move/copy ops, directory creation, metadata. Saivage's is sync `fs.*` — the official one is async, hardened, widely tested |
| `git` (217 LOC) | **mcp-server-git** | `uvx mcp-server-git` (Python) | 10+ tools vs Saivage's 8. Better diff output, stash support, remote management. Saivage's `simple-git` wrapper is fine but this is more complete |
| `web` (125 LOC) | **@modelcontextprotocol/server-fetch** | `uvx mcp-server-fetch` | Robots.txt respect, content extraction, rate limiting. Saivage's `cheerio`-based scraper works but the official one handles encoding, redirects, UA rotation better |
| `memory` (203 LOC) | **@modelcontextprotocol/server-memory** | `npx -y @modelcontextprotocol/server-memory` | Knowledge-graph-based (entities + relations + observations) vs Saivage's flat key-value FTS5. Much richer memory model for an autonomous agent. Uses JSON file storage — portable |

### Keep As-Is
| Saivage Service | Why Keep |
|---|---|
| `lock` (160 LOC) | **Unique** — no MCP equivalent exists. SQLite WAL, shared/exclusive modes, TTL, namespaces. Essential for self-modification safety |
| `index` (209 LOC) | **Custom domain** — conversation and work tracking with FTS5. No off-the-shelf MCP does this |
| `shell` (51 LOC) | **Simple enough** — just `execSync`. The official servers don't ship a standalone shell MCP |

### Action Item
- [ ] Make filesystem/git/web/memory pluggable: allow config to point at either
  built-in or external MCP server process. This lets users pick official
  servers or keep the bundled ones.

---

## 2. New MCP Servers to Add (from the ecosystem)

These don't exist in Saivage and would give major capability boosts:

| MCP Server | Source | Adds |
|---|---|---|
| **Sequential Thinking** | `@modelcontextprotocol/server-sequentialthinking` (official) | Dynamic problem-solving via thought sequences. Branching, revision, hypothesis testing. Directly useful for planner agent |
| **GitHub MCP** | `github/github-mcp-server` (official) | Full GitHub API: issues, PRs, repos, code search, file ops. Essential for an autonomous agent that needs to interact with GitHub |
| **Playwright** | `microsoft/playwright-mcp` (official) | Browser automation: navigate, click, screenshot, scrape. Much better than Saivage's `cheerio` fetch for dynamic pages |
| **Docker** | `ckreiling/mcp-server-docker` (community) | Container management for proper sandboxing — Saivage's file-copy sandbox should use this |
| **Database** | `@modelcontextprotocol/server-postgres` or `sqlite` server | Direct DB access beyond Saivage's internal SQLite |

### Action Item
- [ ] Add MCP config section for "external servers" — any MCP server can be
  registered by command + args (like Claude Desktop's `mcp.json` format)
- [ ] The builtins registry already supports this — just expose it in config

---

## 3. Architectural Patterns to Adopt

### From GitHub Copilot/VSCode

| Pattern | What It Does | Apply to Saivage |
|---|---|---|
| **Tool Deferral** | Only ~7 core tools sent initially. Others discovered on-demand via regex/semantic search. Reduces prompt bloat | Saivage sends ALL tools to the LLM. Implement deferred tool loading — core tools in prompt, rest discoverable via a `tool_search` meta-tool |
| **ToolSets** | Group tools by function: `execute`, `edit`, `search`, `read`, `web`, `agent`, `todo`. Skills/agents request sets, not individual tools | Replace Saivage's flat tool list with grouped ToolSets. Agent types get different sets (planner gets `search`+`read`, coder gets all) |
| **Sub-Agent Delegation** | `runSubagent` spawns nested chat sessions with depth tracking to prevent recursion. Named agents from config files | Saivage already has `SubAgent` — add depth tracking and configurable named agents (from YAML/JSON definitions) |
| **Permission Levels** | `autoApprove` vs `confirmation-required` per tool. Sandboxed tools get auto-approved | Add tool permission levels to Saivage. Safe tools (read, search) auto-approved. Dangerous tools (shell, write) need confirmation or sandbox |
| **MCP Gateway** | `startMcpGateway()` creates localhost HTTP proxy exposing all MCP servers — enables external access | Saivage's Fastify server could expose MCP tools via HTTP/SSE. Useful for web UI integration |
| **Dual Tool Naming** | Internal names (`copilot_readFile`) mapped to agent-facing names (`read_file`) | Use friendly names in prompts while keeping SDK-compatible internal names |

### From OpenClaw

| Pattern | What It Does | Apply to Saivage |
|---|---|---|
| **Skills Platform** | `SKILL.md` files with metadata (description, tools, prompts). ClawHub registry for sharing | Saivage already has SKILL.md files + loader/resolver. Add: marketplace registry for community skills |
| **Workspace Files** | `AGENTS.md` (agent configs), `SOUL.md` (personality), `TOOLS.md` (permitted tools) per project | Add project-level configuration files that override global config. Agent reads workspace root for `.saivage/` config |
| **Session Isolation** | Each agent session gets isolated Docker containers, temp directories, env vars | Improve Saivage's sandbox from file-copy to Docker-based isolation per agent session |
| **Async Task Queue** | `openclaw_chat_async` → returns task ID → poll `openclaw_task_status`. For long-running agent work | Saivage's orchestrator already has work IDs and state tracking. Expose this pattern via HTTP API for async agent invocations |
| **Agent-to-Agent Protocol** | `sessions_send` / `sessions_history` for inter-agent communication | Saivage agents currently communicate only via EventBus. Add direct agent-to-agent message passing for collaborative work |

### From OpenFang

| Pattern | What It Does | Apply to Saivage |
|---|---|---|
| **HAND.toml Packages** | Autonomous agent packages: system prompt + SKILL.md + guardrails + tool permissions. Publishable units | Extend Saivage's skill system to full "agent packages" with bundled tools, prompts, and constraints |
| **Signed Manifests** | Ed25519 signed manifests for MCP servers / skills. Verify integrity before executing | Add provenance verification for external MCP servers and skill files. Saivage already has SHA-256 provenance for self-generated content |
| **WASM Sandbox** | Dual-metered WASM sandbox for untrusted code (CPU + memory limits) | Long-term: consider WASM-based sandboxing for generated MCP services instead of file-copy |
| **25 MCP Templates** | Pre-built MCP server templates in `openfang-extensions` | Saivage's generator pipeline could use templates as starting points instead of generating from scratch |
| **16-Layer Security** | SSRF protection, taint tracking, Merkle audit chains, prompt injection scanner | Saivage has injection scanning + secret redaction but lacks SSRF protection, taint tracking, and Merkle audit chains. Wire existing security into the data flow |

---

## 4. Priority Implementation Order

### Phase A — Quick Wins (High value, low effort)

1. **Wire security into agent loop** — Scanner/redactor exist but aren't called.
   Add to tool result processing in `base.ts` ReAct loop.

2. **External MCP server config** — Allow `<project>/.saivage/saivage.json` to declare
   external MCP servers by command+args (same format as Claude Desktop
   `mcp.json`). The runtime already supports this — just expose it.

3. **Tool deferral** — Add a `tool_search` tool that lets the LLM discover
   tools from registered MCP servers on-demand. Send only core tools (shell,
   filesystem, git) in the initial prompt.

4. **ToolSets for agent types** — Planner gets read+search. Coder gets
   read+search+edit+execute. Researcher gets read+search+web. Instead of
   giving every agent every tool.

### Phase B — Medium Effort, High Value

5. **Replace memory service** with knowledge-graph model from
   `@modelcontextprotocol/server-memory`. Entities, relations, observations >>
   flat key-value.

6. **Add Sequential Thinking** MCP server for the planner agent.

7. **Add GitHub MCP server** — essential for any autonomous coding agent.

8. **Workspace config files** — `.saivage/agents.md`, `.saivage/tools.md`,
   `.saivage/skills/` per project. Override global config.

9. **Async HTTP API** — Expose orchestrator work as async endpoints:
   `POST /api/work` → task ID, `GET /api/work/:id` → status/result.

### Phase C — Larger Efforts

10. **Docker-based sandboxing** — Replace file-copy sandbox with Docker
    containers. Use `mcp-server-docker` or direct Docker API.

11. **Playwright MCP** for real browser automation (replace cheerio scraper).

12. **Agent packages** — Extend SKILL.md to full agent packages with bundled
    system prompts, tool permissions, and guardrails.

13. **Streaming** — Implement `streamChat()` on providers. Required for
    responsive UI.

14. **Signed manifests** — Ed25519 signing for registered MCP servers and
    skills. Verify before execution.

---

## 5. Repos to Watch / Reference

| Repo | Stars | Why |
|---|---|---|
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | 40k+ | Official reference servers. filesystem, git, memory, fetch, sequential-thinking |
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | 355k | Skills platform, workspace injection, session isolation, Gateway architecture |
| [github/github-mcp-server](https://github.com/github/github-mcp-server) | — | Official GitHub MCP. Must-have for coding agents |
| [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | — | Official browser automation MCP |
| [RightNow-AI/openfang](https://github.com/RightNow-AI/openfang) | 16.6k | 25 MCP templates, HAND.toml agent packages, security patterns |
| [mcp-use/mcp-use](https://github.com/mcp-use/mcp-use) | 9.8k | Fullstack MCP framework — patterns for building MCP apps |
| [freema/openclaw-mcp](https://github.com/freema/openclaw-mcp) | 136 | Async task queue MCP bridge pattern |
| [microsoft/vscode](https://github.com/microsoft/vscode) | — | Tool deferral, ToolSets, permission levels, MCP gateway |

---

## 6. Key Takeaway

Saivage's architecture is already well-aligned with the ecosystem:
- MCP SDK integration ✅
- SKILL.md system ✅ (matches OpenClaw)
- ReAct agent loop ✅ (matches Copilot's sub-agent pattern)
- Orchestrator with event bus ✅
- 7 built-in services ✅

The biggest gaps vs the ecosystem are:
1. **No tool deferral** — sends all tools, wastes tokens
2. **Security not wired in** — scanner/redactor exist but unused
3. **No external MCP server support** — can't use GitHub, Playwright, etc.
4. **Flat memory** — knowledge graph (official server) >> key-value
5. **No Docker sandboxing** — file copy is insufficient
6. **No streaming** — required for responsive UX
