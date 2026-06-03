# Saivage v2 Architecture Remediation Plan

This packet records the design decisions and execution plan for cleaning up the
issues found in the June 2026 Saivage v2 architecture assessment.

Saivage v2 is an isolated-container runtime. The HTTP API is expected to be
reachable only from the host, so this plan does not require bearer-token auth as
a primary safety mechanism. The goal is simpler internal structure, clearer
contracts, and fewer places where prompts or conventions substitute for runtime
policy.

## Scope

The plan addresses these fix areas:

| Order | Area | Design Doc | Outcome |
| --- | --- | --- | --- |
| 1 | Type contracts | [RAG config type contract](./rag-config-type-contract.md) | Restore `npm run typecheck`; make config and runtime dataset types agree. |
| 2 | Role access boundaries | [Role access boundaries](./role-access-boundaries.md) | Enforce existing role/tool filters and write-territory conventions at runtime boundaries. |
| 3 | Dispatch semantics | [Dispatcher semantics](./dispatcher-semantics.md) | Align implementation and docs around parallel batch dispatch. |
| 4 | Abort and restart control | [Abort control path](./abort-control-path.md) | Remove stale urgent-note abort/rollback semantics; use the existing explicit restart path. |
| 5 | MCP lifecycle | [MCP lifecycle simplification](./mcp-lifecycle-simplification.md) | Rename/document external MCP startup behavior as autostart-only. |
| 6 | Local API posture | [Local API and debug posture](./local-api-debug-posture.md) | Keep container-local API simple while avoiding accidental secret/config exposure. |

## Guiding Decisions

- Prefer small correctness fixes before structural changes.
- Keep v2 stable as a deployed harness; do not redesign it into v3.
- Enforce policy where runtime calls already converge, but avoid new policy
  abstractions that duplicate existing roster/filter/convention data.
- Remove misleading abstractions when they add surface area without real behavior.
- Treat prompt instructions as guidance only; runtime guarantees must be enforced in code.
- Keep API token support optional because deployment isolation is the intended security boundary.

## Execution Phases

### Phase 1: Correctness Gates

1. Complete the partial RAG config/type widening already present in
   `src/config.ts`.
2. Run `npm run typecheck` and `npm test`.
3. Update docs if the RAG model configuration surface changes.

### Phase 2: Role Access Boundaries

1. Make runtime/operator call sites pass explicit operator context where needed.
2. Update direct-call tests to use explicit operator context where appropriate.
3. Add role/tool enforcement in `McpRuntime.callTool` using the existing
   `tool-filters.ts` source.
4. Decide and implement external MCP behavior for agent-originated calls.
5. Upgrade `conventions.ts` from warning-only to enforceable path decisions.
6. Wire write/download/commit handlers through those path decisions.
7. Add focused tests for blocked tools, blocked writes, and operator bypass.

### Phase 3: Runtime Semantics Cleanup

1. Update dispatcher comments/docs to describe parallel batch dispatch.
2. Remove stale urgent-note abort/rollback helpers and docs.
3. Rename MCP service methods and comments so they do not imply lazy startup.
4. Update architecture docs so they describe current implementation, not
   aspirational behavior.

### Phase 4: Local API and Docs

1. Remove raw runtime config from debug endpoints; use explicit safe response
   shapes instead of broad redaction.
2. Add clear docs explaining container-local trust assumptions.
3. Expand file-browser hiding for known sensitive filenames.
4. Run `npm run docs:build` if docs pages changed.

## Success Criteria

- `npm run typecheck` passes.
- `npm test` passes.
- In-process agent-visible tools and runtime-executable tools use the same
  permission source; external MCP tools have an explicit documented behavior.
- Role mutation boundaries are enforced by code, not only prompts.
- Debug/config/file endpoints do not expose raw provider, account, auth-profile,
  account-ref, or token-bearing values.
- Architecture docs no longer claim unimplemented lazy MCP startup, urgent-note abort, or resume-on-each semantics unless those behaviors are implemented.
