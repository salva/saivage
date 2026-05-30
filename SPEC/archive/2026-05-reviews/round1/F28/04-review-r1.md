## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F28-mcp-registry-unused.md](SPEC/v2/review-2026-05/F28-mcp-registry-unused.md)
- [SPEC/v2/review-2026-05/F28/01-analysis-r1.md](SPEC/v2/review-2026-05/F28/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F28/02-design-r1.md](SPEC/v2/review-2026-05/F28/02-design-r1.md)
- [SPEC/v2/review-2026-05/F28/03-plan-r1.md](SPEC/v2/review-2026-05/F28/03-plan-r1.md)
- Spot-checks: [src/mcp/registry.ts](src/mcp/registry.ts), [src/mcp/runtime.ts](src/mcp/runtime.ts), [src/mcp/index.ts](src/mcp/index.ts), [src/server/bootstrap.ts](src/server/bootstrap.ts), [skills/builtin/mcp-authoring/SKILL.md](skills/builtin/mcp-authoring/SKILL.md), [SPEC/v2/05-MCP-SERVICES.md](SPEC/v2/05-MCP-SERVICES.md)

## Findings

### Analysis

The central implementation direction is sound, but r1 overstates the registry's deadness. [SPEC/v2/review-2026-05/F28/01-analysis-r1.md](SPEC/v2/review-2026-05/F28/01-analysis-r1.md) says the file is never read for a consequential decision and that there is no mechanism that would consume a manually registered entry. The runtime does have live read paths: [src/mcp/runtime.ts](src/mcp/runtime.ts#L96-L110) lazy-starts a service from `getService(name)` when it is not already running, [src/mcp/runtime.ts](src/mcp/runtime.ts#L216-L247) includes active registry tools in `getAllTools()`, and [src/mcp/runtime.ts](src/mcp/runtime.ts#L249-L307) includes them in the API projection. Those catalogs are consumed by [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L167-L198), [src/agents/base.ts](src/agents/base.ts#L598), and [src/server/server.ts](src/server/server.ts#L243). The correct factual claim is narrower: v2 has no in-repo producer for registry entries because `registerService` / `unregisterService` are not called, and configured external servers are started from `config.mcpServers` instead.

The documentation-drift section also needs that distinction. [skills/builtin/mcp-authoring/SKILL.md](skills/builtin/mcp-authoring/SKILL.md#L20) and [SPEC/v2/05-MCP-SERVICES.md](SPEC/v2/05-MCP-SERVICES.md#L410-L414) currently instruct authors to create registry entries manually. Those docs may be stale and should be deleted under the project no-backward-compatibility rule, but r1 should not claim that such an entry would be unconsumed by the current runtime.

### Design

Proposal B remains the cleaner endpoint: deleting [src/mcp/registry.ts](src/mcp/registry.ts), moving the surviving entry shapes to [src/mcp/types.ts](src/mcp/types.ts), and making `config.mcpServers` the only MCP declaration source matches the architecture-first guideline. However, the risk section needs revision. [SPEC/v2/review-2026-05/F28/02-design-r1.md](SPEC/v2/review-2026-05/F28/02-design-r1.md) says removing the registry only changes behavior if a user populated the file by hand but that there is no documented way to do so, and also says nothing reads `.saivage/registry.json`. Both are factually wrong against the current docs and runtime. The recommended design can still intentionally delete that stale manual path, but it must name the behavioral removal explicitly.

### Plan

The implementation steps are mostly executable and complete, including the TypeDoc update and the `status` field removal from the external-server literal. Two plan details need tightening before approval:

1. Because the registry reader is an observable lazy-start/catalog path when `.saivage/registry.json` exists, the optional `startService("ghost")` test should either become required or the plan should add an equivalent focused test for the new config-pointing error. This gives the deletion a pinned replacement behavior rather than relying only on typecheck.
2. The manual sanity command in [SPEC/v2/review-2026-05/F28/03-plan-r1.md](SPEC/v2/review-2026-05/F28/03-plan-r1.md) uses a top-level `tests/` path, but this repo's tests are co-located under `src/`; running the command as written emits `rg: tests: No such file or directory` / `grep: tests/: No such file or directory`. Replace it with an executable command over existing paths, for example `rg -n "registry\.json|registerService|unregisterService|listRegisteredServices|updateServiceStatus|getService\b" src web skills SPEC/v2/05-MCP-SERVICES.md SPEC/v2/06-SYSTEM-DESIGN.md typedoc.json` after accounting for intentionally historical review files.

## Required changes

1. Revise the analysis to distinguish "no v2 producer / no automatic registry creation" from "no reader." Acknowledge that existing active registry entries are currently consumed by `startService`, `getAllTools`, and `listAllToolsForApi`.
2. Revise the design risk for Proposal B to state that deleting [src/mcp/registry.ts](src/mcp/registry.ts) intentionally removes the stale documented manual registry path. Keep the no-backward-compatibility conclusion, but do not describe the path as unread or undocumented.
3. Tighten the plan's test strategy so the new `startService` error behavior is required or otherwise covered by an equivalent focused test.
4. Replace the non-executable validation grep over `tests/` with a command that matches this repo's co-located test layout and includes the docs that F28 plans to update.

## Strengths

- Correctly preserves `ServiceEntry` and `ToolEntry` as live shapes while deleting the dead persistence helpers.
- Proposal B is appropriately architecture-first: it removes the misleading `registry.ts` name rather than leaving a type-only registry module.
- The plan catches important secondary cleanup in [src/mcp/index.ts](src/mcp/index.ts), [typedoc.json](typedoc.json), and the stale MCP authoring/spec docs.

VERDICT: CHANGES_REQUESTED
