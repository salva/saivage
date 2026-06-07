# Saivage Codex Instructions

Scope: `/home/salva/g/ml/saivage`.

Project-specific Copilot skills live in `.github/skills/`. Converted Codex copies have been installed under `/home/salva/.codex/skills/` with `saivage-` scoped names where needed.

Read `/home/salva/g/ml/CODEX_PROJECT_MEMORY.md` before substantial work here.

## Design Principles

- **Simple and clean architecture over everything.** When the clean solution requires a larger, deeper, or more complex change, take the better path. Do not compromise architecture to minimize diff size or avoid refactoring.
- **Zero backward compatibility weight.** Old test structures, on-disk formats, tool names, API shapes, and runtime conventions that are being replaced have zero weight in design decisions. Remove them outright. No aliases, shims, or transition periods.
- **Be brave.** Tackle large, deep, or complex changes when they result in the better solution. Do not preserve legacy patterns out of caution.
- **Small, predictable tool vocabulary.** Prefer a few general tools over many specialized ones. Avoid action-dispatch patterns inside a single tool. Model-facing tool names describe agent intent, not internal service partitioning.
- **One overflow mechanism.** Prefer unified spill/stash over per-tool ad-hoc overflow paths.
- **Explicit parameter interactions.** When a tool has multiple optional parameters, specify the interaction table for all valid and invalid combinations.
- **Type safety in handler contracts.** Handler return types should explicitly distinguish success from error. No `Promise<unknown>` return types.

## Project-Specific Skills

- `saivage-container`: operate the old Saivage LXC container and service.
- `saivage-mcp-builder`: build MCP servers using the project-local MCP guidance.
- `saivage-skill-creator`: use the project-local skill creation workflow.
- `saivage-webapp-testing`: use the project-local Playwright webapp testing workflow.

## Safety

- Preserve secrets. Do not read, print, or copy `.saivage/auth-profiles.json`, provider configs, env files, shell history, token files, or backups unless the user explicitly authorizes it.
- Prefer the workspace-level Saivage/LXC instructions in `/home/salva/g/ml/AGENTS.md` for container operations unless this project-specific file is more precise.
