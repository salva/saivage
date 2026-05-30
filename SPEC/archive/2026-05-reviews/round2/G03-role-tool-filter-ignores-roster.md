# G03 — `ROLE_TOOL_FILTER` ignores `roster.toolFilter` and omits half the roles

**Subsystem:** src/agents/
**Category:** architecture / single-source-of-truth violation
**Severity:** high
**Transversality:** architectural (cross-cutting roster contract)

## Summary

`BaseAgent.getToolSchemas()` filters the MCP toolset available to each agent via a hand-rolled `ROLE_TOOL_FILTER` map at the bottom of [src/agents/base.ts](src/agents/base.ts#L1104-L1123). The ROSTER declares a `toolFilter: ToolFilterKind` field for every role exactly to drive this decision ([src/agents/roster.ts](src/agents/roster.ts#L24-L25)), but that field is dead code — `base.ts` never reads it. The hand-rolled map also has no entries for `manager`, `designer`, or `chat`, so those three roles fall through to "no filter" and receive the full MCP toolset, in direct contradiction to the roster's declared filter strategy.

## Evidence

Roster declares per-role intent:

```ts
// src/agents/roster.ts:46  planner   toolFilter: "planner"
// src/agents/roster.ts:64  manager   toolFilter: "worker"
// src/agents/roster.ts:137 reviewer  toolFilter: "reviewer"
// src/agents/roster.ts:156 designer  toolFilter: "worker"
// src/agents/roster.ts:175 inspector toolFilter: "inspector"
// src/agents/roster.ts:197 chat      toolFilter: "chat"
```

The grep `grep -n "toolFilter\|getToolsForRole" src/agents src/runtime -r` returns **only** the roster declarations and the JSDoc above the field. There is no consumer.

Meanwhile [src/agents/base.ts](src/agents/base.ts#L1104-L1123):

```ts
const ROLE_TOOL_FILTER: Partial<Record<AgentRole, (toolName: string, service: string) => boolean>> = {
  planner:    (n) => PLAN_TOOLS.has(n) || READ_ONLY_TOOLS.has(n) || n === "read_stash",
  inspector:  (n) => READ_ONLY_TOOLS.has(n) || n === "run_command" || n === "read_stash" ||
                     n === "web_search" || n === "fetch_url" || n === "fetch_page_text",
  reviewer:   (n) => READ_ONLY_TOOLS.has(n) || n === "run_command" || n === "read_stash",
  coder:      (n) => !WORKER_EXCLUDED_TOOLS.has(n),
  researcher: (n) => !WORKER_EXCLUDED_TOOLS.has(n),
  data_agent: (n) => !WORKER_EXCLUDED_TOOLS.has(n),
};
```

Six roles configured. `manager`, `designer`, `chat` are missing. [src/agents/base.ts](src/agents/base.ts#L628-L634) then does `roleFilter ? allTools.filter(...) : allTools` — when the entry is missing, the agent gets every tool the runtime offers, including plan-management and write tools.

The `coder`/`researcher`/`data_agent` entries are also bytewise identical (`(n) => !WORKER_EXCLUDED_TOOLS.has(n)`), which is exactly what `roster.toolFilter === "worker"` was meant to encode.

## Why this matters

- The roster contract is silently violated for `manager` (gets every tool, including plan mutation), `designer` (no `worker` filtering — gets plan tools), and `chat` (designed by §H.1 to be the *one* role with no direct write access; currently nothing prevents it from calling `write_file`). For the security-conscious Chat role this is especially bad: a prompt-injected Chat session can in principle modify project files.
- `roster.toolFilter` is the kind of declarative field that, when unused, lulls reviewers into thinking the contract is enforced. It's a foot-gun for future roles: adding a new entry to ROSTER with the "correct" `toolFilter` value will have zero runtime effect.
- Same root cause as G01 and G02: ROSTER declares the intent, individual modules redeclare a literal table, and the two drift.

## Rough remediation direction

Architectural, derive-from-roster:

1. Move tool-filter implementations to a `src/runtime/toolFilter.ts` (or `src/agents/toolFilter.ts`) keyed by the `ToolFilterKind` union: `{ planner, worker, reviewer, inspector, chat }`.
2. Export `getToolFilter(role: AgentRole): (toolName, service) => boolean` that resolves via `getRoster(role).toolFilter`.
3. Decide whether the missing `manager` filter was intentional (manager only dispatches workers and writes summaries) or accidental. Round-2 design call: add a `"manager"` filter kind, or treat manager as "worker minus dispatch-of-self". Either way, force exhaustiveness via `assertExhaustive` so a future role without a filter kind is a compile error.
4. Delete `ROLE_TOOL_FILTER` from base.ts entirely.

Add a roster-level test that asserts `getToolFilter(role)` exists for every role in `ALL_ROLES`, and a black-box test that lists, for each role, the resulting tool set (snapshot-tested).

## Cross-links

- Same class as G01 (supervisor priority), G02 (dispatcher limit), G04 (manager `validateFinalResponse`).
- Reinforces round-1 architecture goal that ROSTER be the single source of truth (F23/F26).
- Security implication overlaps with the Chat write-access invariant called out in [src/chat/slashCommands.ts](src/chat/slashCommands.ts#L19-L21).
