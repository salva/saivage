# Saivage Project Review - 2026-05-01

## Scope

This review looked across the TypeScript server/runtime, agent hierarchy, model providers, MCP tools, web/Telegram chat integration, deployment scripts, specs, and tests. The goal was to identify design issues that affect reliability, safety, maintainability, and the quality of autonomous agent execution, then turn the most practical fixes into code immediately.

## Executive Summary

Saivage has a strong core architecture: document-backed planning, a clear Planner -> Manager -> worker hierarchy, MCP-style tools, persistent project state, and a usable web/Telegram control surface. The highest-value improvement areas are now less about inventing a new architecture and more about tightening contracts around the existing one.

The main risks found are:

1. Runtime contracts had drifted from implementation. The code used notification config, event timestamps, Telegram options, and Planner result metadata that were not correctly represented in TypeScript schemas.
2. Built-in tool security was too permissive. Filesystem tools accepted absolute paths outside the project, and skill tools allowed path-like names.
3. The MCP surface is too flat and eager. Every tool is available up front, including stubs and high-risk tools, which increases prompt size and invalid tool calls.
4. Some services are registered as stubs while appearing as normal tools. This makes agents waste turns discovering at runtime that web, memory, index, and lock are unavailable.
5. Provider integration is improving, but provider capabilities are still spread across provider classes and runtime assumptions instead of a single capability model.
6. Tests cover important primitives, but there is little end-to-end coverage for chat commands, Planner restart control, provider model listing, and agent handoff context.
7. Deployment is now functional for `target`, but deployment defaults and runtime configuration are still partly encoded in scripts rather than validated as an explicit environment profile.

## Findings

### 1. Runtime Schema Drift

Several runtime paths were using fields that were missing or too narrow in the shared schemas:

- `runtime.config.notifications` was used by Telegram but absent from `SaivageConfig`.
- `SystemEvent` did not allow `timestamp`, even though recovery publishes timestamped events.
- recovery logic read `result.data.summary` without narrowing the success payload type.
- Telegram used an older `grammy` link-preview option shape.

Impact: full `tsc --noEmit` failed, which weakens confidence in all later refactors.

Status: fixed in this pass.

### 2. Built-In Tool Containment

The in-process filesystem tools resolved absolute paths as-is. That meant an agent could ask `read_file` or `write_file` to touch files outside the active project root. Skill names were also interpolated directly into paths.

Impact: accidental host-file access or overwrite is possible, especially when autonomous agents use absolute paths from logs or copied instructions.

Status: partially fixed in this pass. Filesystem paths are now constrained to the project root, and skill names are restricted to safe filename characters. Shell commands still need a stronger sandbox because a shell command can reference absolute paths independently of the filesystem helper.

### 3. Tool Model And Prompt Size

The runtime currently exposes all tools returned by `mcpRuntime.getAllTools()`. This includes stubs and tools irrelevant to the agent role. Invalid tool calls are handled after the fact by the dispatcher.

Impact: agents receive a noisier tool menu, spend turns on unavailable stubs, and have more room to choose risky tools when a safer read/search operation would do.

Recommended direction:

- Introduce tool groups such as `read`, `write`, `execute`, `git`, `agent`, `plan`, `chat`, and `admin`.
- Give each agent role an allowed set.
- Hide unavailable stub services unless explicitly enabled.
- Add a `tool_search` or `tool_catalog` meta-tool for deferred discovery of less common tools.

### 4. External MCP Server Configuration

The architecture is already close to supporting external MCP services, but runtime config does not expose a clean Claude Desktop-style `mcpServers` section.

Impact: replacing built-in filesystem/git/web/memory with battle-tested MCP servers remains a manual code change instead of a project-level configuration choice.

Recommended direction:

- Add a typed `mcpServers` config section with command, args, env, disabled flag, and optional tool allowlist.
- Register external services during bootstrap before built-ins or with explicit precedence rules.
- Document the recommended official MCP server replacements.

### 5. Provider Capability Model

The GitHub Copilot provider now dynamically lists models and supports Responses API routing, but provider capability details are still hidden behind provider-specific methods.

Impact: callers can list model IDs but cannot reason uniformly about endpoints, context windows, tool support, image support, or model-picker visibility.

Recommended direction:

- Add a `ModelInfo` shape to provider interfaces.
- Make `/api/providers` return capabilities, not only IDs.
- Use capabilities to select chat-completions vs responses vs Anthropic paths without model-name special cases where possible.

### 6. Chat And Planner Control

The chat surface is now closer to the intended system identity and can explicitly request Planner restarts. This needs regression coverage so future prompt edits do not break deterministic command handling.

Recommended direction:

- Add tests around `/restart-planner`, natural-language explicit Planner restart detection, and `/help` command output.
- Add a small `PlannerControl` unit test that avoids importing full bootstrap dependencies if possible.

### 7. Agent Handoff Context

The new handoff context reduces the risk of short, under-specified child prompts. The next step is to make the context budget-aware and role-aware.

Recommended direction:

- Add token or character budgets for plan history and task lists.
- Include only the most relevant stage/task records for workers.
- Add tests that snapshot the sections included for Planner, Manager, Worker, and Inspector handoffs.

### 8. Deployment Profiles

The LXC setup is now documented for `target`, but deployment remains a mix of Make variables, script defaults, and generated service files.

Recommended direction:

- Add a typed deployment profile example for target project mount, service port, host path, and container path.
- Have deploy scripts validate required paths and print the effective profile before mutating container config.

## Implementation Plan

### Phase 1 - Restore Contract Integrity

Status: completed.

- Extend runtime config typing to include notifications.
- Let `SystemEvent` carry optional timestamps.
- Fix Planner recovery result narrowing.
- Update Telegram send-message options for current `grammy` types.
- Keep full `npm run typecheck` green.

### Phase 2 - Harden Built-In Tool Boundaries

Status: partially completed.

- Restrict filesystem tool paths to the active project root.
- Restrict skill names to safe filename characters and keep skill paths under `.saivage/skills`.
- Add regression tests through the public MCP runtime API.
- Next: add a shell execution policy with blocked absolute path patterns, explicit cwd containment, timeout/output limits per role, and eventually container sandboxing.

### Phase 3 - Reduce Tool Noise

Status: partially completed.

- Add a tool availability state so stub tools are not advertised as normal tools. Completed for in-process stubs in this pass.
- Add role-level tool groups.
- Add a deferred tool catalog/search tool.

### Phase 4 - External MCP Config

Status: planned.

- Add `mcpServers` to `SaivageConfig`.
- Register external MCP services at bootstrap.
- Support disabled services and per-service tool allowlists.

### Phase 5 - Capability-Aware Providers

Status: planned.

- Add `ModelInfo` provider API.
- Return provider/model capabilities from `/api/providers`.
- Move endpoint selection away from scattered name checks.

### Phase 6 - End-To-End Runtime Tests

Status: planned.

- Test chat restart commands.
- Test handoff context sections and budget behavior.
- Test provider list models with mocked Copilot metadata.
- Test deployment-sensitive config parsing without needing LXC.

## Changes Made In This Pass

- Fixed TypeScript contract drift in `src/config.ts`, `src/types.ts`, `src/server/bootstrap.ts`, and `src/server/telegram-bot.ts`.
- Hardened built-in filesystem and skill path handling in `src/mcp/builtins.ts`.
- Hid unavailable built-in stub tools from the agent-facing MCP tool catalog in `src/mcp/runtime.ts` and `src/mcp/builtins.ts`.
- Added containment regression tests in `src/mcp/builtins.test.ts`.
- Verified `npm run typecheck` passes.
- Verified `npm test` passes: 8 test files, 95 tests.

## Next Recommended Work

The next best implementation target is Phase 3: tool grouping and hiding unavailable stubs. It should improve agent reliability quickly because it reduces prompt clutter and prevents wasted tool-call rounds. After that, external MCP configuration becomes much cleaner because each external service can declare its group and availability explicitly.