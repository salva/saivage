# Saivage Codex Instructions

Scope: `/home/salva/g/ml/saivage`.

Project-specific Copilot skills live in `.github/skills/`. Converted Codex copies have been installed under `/home/salva/.codex/skills/` with `saivage-` scoped names where needed.

Read `/home/salva/g/ml/CODEX_PROJECT_MEMORY.md` before substantial work here.

## Project-Specific Skills

- `saivage-container`: operate the old Saivage LXC container and service.
- `saivage-mcp-builder`: build MCP servers using the project-local MCP guidance.
- `saivage-skill-creator`: use the project-local skill creation workflow.
- `saivage-webapp-testing`: use the project-local Playwright webapp testing workflow.

## Safety

- Preserve secrets. Do not read, print, or copy `.saivage/auth-profiles.json`, provider configs, env files, shell history, token files, or backups unless the user explicitly authorizes it.
- Prefer the workspace-level Saivage/LXC instructions in `/home/salva/g/ml/AGENTS.md` for container operations unless this project-specific file is more precise.
