# MCP Lifecycle Simplification

## Problem

Docs describe external MCP services as lazy-started on first tool call. The
implementation registers built-ins in-process and starts configured external
servers only during bootstrap when `autostart` is true. `startService(name)` and
`getClient(name)` both throw if the service is not already running.

This is another docs-vs-code mismatch and also suggests an unused abstraction:
the runtime has lazy-start terminology without lazy-start behavior for named
configured services.

## Options Considered

| Option | Pros | Cons |
| --- | --- | --- |
| Implement true lazy startup for configured external MCP servers | Matches docs; can reduce startup overhead. | Requires retaining service entries, handling first-call startup latency, and surfacing startup failures to agents. |
| Keep autostart-only and update docs | Simple and stable. | External services that are disabled at boot cannot be started by tool call. |
| Remove external MCP lifecycle support | Simplest v2 core. | Breaks configured external MCP integrations. |

## Chosen Approach

Keep autostart-only external MCP behavior for v2 and update the docs/API naming
to match. Do not implement true lazy startup unless a concrete external service
needs it.

## Design

- Built-ins are registered in-process and always available unless explicitly
  marked unavailable as a stub.
- External MCP servers are started during bootstrap only when configured with
  `autostart: true` and not disabled.
- Health monitoring applies only to already-running external services.
- Idle shutdown needs a deliberate decision because it can stop an autostarted
  service and make later calls fail. Prefer disabling idle shutdown for external
  services unless a clear restart path exists; otherwise improve the error so it
  says the service was stopped due to inactivity.
- Rename misleading methods/comments instead of preserving lazy-start wording:
  - The `McpRuntime` class JSDoc should not claim “lazy loading”.
  - `startService(name)` -> `getRunningService(name)` or equivalent.
  - Remove redundant `getClient(name)` if all call sites can use
    `getRunningService(name)` directly; otherwise update its comment so it says
    it returns an already-running client.
  - Update `callTool` comments so they do not claim lazy-start behavior.

## Execution Plan

1. Update docs and source comments to remove lazy-start claims, including the
   `McpRuntime` class JSDoc that currently mentions “lazy loading”.
2. Rename internal method `startService` to `getRunningService` for clarity.
3. Remove `getClient` if it is only a redundant alias, or update its comment and
   call sites if keeping it is clearer.
4. Update `callTool` comments and error text so they do not imply lazy startup.
5. Decide idle-shutdown behavior for external services.
6. Keep `startFromEntry` as the only startup path for external entries.
7. Add a test that a configured non-autostart service is not exposed as running
   and returns a clear error on direct call.

## Validation

- `npm run typecheck`
- `npm test`
- Documentation search for `lazy` in MCP docs should not describe unsupported
  external service behavior.

## Risks

- Renaming touches internal call sites and tests, but it removes misleading API
  names. Since external compatibility is not a constraint for this remediation,
  clarity wins.
