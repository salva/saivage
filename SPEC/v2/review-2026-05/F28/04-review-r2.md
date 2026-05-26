## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F28-mcp-registry-unused.md](SPEC/v2/review-2026-05/F28-mcp-registry-unused.md)
- [SPEC/v2/review-2026-05/F28/04-review-r1.md](SPEC/v2/review-2026-05/F28/04-review-r1.md)
- [SPEC/v2/review-2026-05/F28/01-analysis-r2.md](SPEC/v2/review-2026-05/F28/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F28/02-design-r2.md](SPEC/v2/review-2026-05/F28/02-design-r2.md)
- [SPEC/v2/review-2026-05/F28/03-plan-r2.md](SPEC/v2/review-2026-05/F28/03-plan-r2.md)
- Spot-checks: [src/mcp/registry.ts](src/mcp/registry.ts), [src/mcp/runtime.ts](src/mcp/runtime.ts), [src/mcp/index.ts](src/mcp/index.ts), [src/server/bootstrap.ts](src/server/bootstrap.ts), [typedoc.json](typedoc.json), [skills/builtin/mcp-authoring/SKILL.md](skills/builtin/mcp-authoring/SKILL.md), [SPEC/v2/05-MCP-SERVICES.md](SPEC/v2/05-MCP-SERVICES.md), [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md)

## Findings

### Analysis

Approved. r2 corrects the r1 factual issue: it no longer describes the registry as unread, and instead distinguishes the live reader paths in `startService`, `getAllTools`, and `listAllToolsForApi` from the absent v2 producer path. That matches the spot-check in [src/mcp/runtime.ts](src/mcp/runtime.ts#L97-L110), [src/mcp/runtime.ts](src/mcp/runtime.ts#L216-L247), and [src/mcp/runtime.ts](src/mcp/runtime.ts#L259-L307), where `getService(name)` and `listRegisteredServices()` are still consulted.

The producer-side claim is also accurate. [src/mcp/registry.ts](src/mcp/registry.ts#L63-L95) defines `registerService`, `unregisterService`, and `updateServiceStatus`, and [src/mcp/index.ts](src/mcp/index.ts#L3-L11) re-exports them, but the spot-check did not find runtime producers outside those definitions/re-exports; configured external servers are built directly from `config.mcpServers` in [src/server/bootstrap.ts](src/server/bootstrap.ts#L708-L733).

The stale manual documentation path is framed accurately. Current docs do still point authors at `.saivage/registry.json` in [skills/builtin/mcp-authoring/SKILL.md](skills/builtin/mcp-authoring/SKILL.md#L20) and [SPEC/v2/05-MCP-SERVICES.md](SPEC/v2/05-MCP-SERVICES.md#L412), and the system diagram still names `registry.json` at [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L313). r2 correctly treats deletion as intentional removal of that manual path under the no-backward-compatibility guideline.

### Design

Approved. Proposal B remains the clean endpoint: delete [src/mcp/registry.ts](src/mcp/registry.ts), move the surviving entry shapes to a type-only module, and make `config.mcpServers` the only supported declaration surface. The risk section now explicitly acknowledges that projects using a hand-written registry file will lose that behavior, which was the missing r1 point. Removing the TypeDoc registry entry is also necessary because [typedoc.json](typedoc.json#L17) currently documents the persistence module directly.

### Plan

Approved. The r2 plan makes the `startService("ghost")` replacement-error test required, drops the stale registry helpers from runtime/index exports, removes the obsolete `status` field from the external-service literal at [src/server/bootstrap.ts](src/server/bootstrap.ts#L718-L730), updates TypeDoc, and rewrites the docs that currently steer authors to the manual registry path. The validation command no longer depends on a nonexistent top-level `tests/` directory and covers the code/docs touched by the change.

## Required changes

## Strengths

- Resolves all r1 factual objections without weakening the architecture-first deletion.
- Keeps the implementation path executable and testable, including a focused assertion for the new config-pointing error.
- Updates runtime code, public exports, TypeDoc, and stale authoring/spec documentation in one coherent plan.

VERDICT: APPROVED