# Specifications

The design behind Saivage lives in two parallel folders:

- [`SPEC/v2/`](https://github.com/salva/saivage/tree/main/SPEC/v2) — the
  canonical specifications. Each implementation page on this site links
  back here.
- [`SPECS/v2/`](https://github.com/salva/saivage/tree/main/SPECS/v2) —
  board-level analysis and improvement plans (active development tracking).

The four most important specs to read first:

| Doc | Scope |
|-----|-------|
| [`00-AGENT-SYSTEM.md`](https://github.com/salva/saivage/blob/main/SPEC/v2/00-AGENT-SYSTEM.md) | Roles, lifecycles, contracts. |
| [`01-DATA-MODEL.md`](https://github.com/salva/saivage/blob/main/SPEC/v2/01-DATA-MODEL.md) | TypeScript interfaces and JSON schemas (mirrors `src/types.ts`). |
| [`04-RUNTIME-DETAILS.md`](https://github.com/salva/saivage/blob/main/SPEC/v2/04-RUNTIME-DETAILS.md) | Suspend/resume, compaction, self-check, recovery. |
| [`06-SYSTEM-DESIGN.md`](https://github.com/salva/saivage/blob/main/SPEC/v2/06-SYSTEM-DESIGN.md) | Master architecture document — start here if reading top-down. |

Other specs:

- `02-IMPLEMENTATION-PLAN.md` — original phased rollout plan.
- `03-PLAN-MCP-SERVICE.md` — full schema for the plan MCP service tools.
- `05-MCP-SERVICES.md` — catalog of every MCP tool the system exposes.
- `prompts/` — system prompts for each agent role.
- `skills/` — the bootstrap skill catalogue (also distributed under `skills/`).

When the implementation diverges from the spec the implementation wins, but
both should be updated. The internals pages on this site cite both source
files and spec sections to make the cross-reference explicit.
