# Role Access Boundaries (Historical)

This note predates the current autonomy-first direction in
[Agent autonomy, conventions, and nudges](./agent-autonomy-conventions.md). It is
kept as historical context for an enforcement-oriented option, not as the active
target design.

The active direction keeps role permissions simple and uses runtime observation,
typed artifact validation, and nudges to correct most role drift. Hard runtime
refusal is reserved for secrets, state corruption, project-root escape,
operator-only actions, and similar safety boundaries.

## Problem

Saivage already has role metadata, tool filters, and write-territory conventions,
but the enforcement is incomplete:

- `BaseAgent` filters tool schemas before showing them to the model.
- `McpRuntime.callTool` executes any known tool when called directly.
- `src/agents/conventions.ts` provides `decidePathMutation()`, which **already
  blocks** write-path mutations that violate role territory. It is wired into the
  `write_file`, `download_file`, `download_with_fallbacks`, `git_commit`, and
  shell command path handlers in `builtins.ts`. Path conventions are not advisory
  — they are enforced at the tool handler level.
- This historical note described enforcement as a future goal, but path enforcement
  is already active. The active direction (autonomy-first) keeps path blocking
  for safety boundaries and adds compliance nudges for behavioral drift.
- Some handlers contain ad-hoc path guards, such as `write_file` blocking direct
  writes under `.saivage/skills/` and `.saivage/memory/`.

The clean target is one role model with enforcement at runtime boundaries, not a
new set of policy tables parallel to the existing roster/filter/convention data.

## Options Considered

| Option | Pros | Cons |
| --- | --- | --- |
| Keep presentation-only filters and warning-only conventions | No code changes. | Direct tool calls bypass role filters; write territories remain advisory. |
| Add new `toolPolicy` and `mutationPolicy` modules | Clear names for policy concepts. | Duplicates `tool-filters.ts`, `conventions.ts`, and `ROSTER`; adds abstraction without new information. |
| Enforce through existing sources of truth | Smallest architecture; one role model. | Requires touching runtime and handler call sites carefully. |

## Chosen Approach

Use the existing role metadata as the policy source:

- `ROSTER` remains the source of role identity, dispatchability, tool-filter kind,
  and write-territory convention.
- `src/agents/tool-filters.ts` remains the source for role-to-tool visibility.
- `src/agents/conventions.ts` becomes the source for role-to-path mutation
  decisions instead of warning-only checks.
- `McpRuntime.callTool` becomes the central role/tool enforcement point.

Do not introduce `src/mcp/toolPolicy.ts` or `src/mcp/mutationPolicy.ts` unless a
future change needs new policy data that does not belong in the existing roster,
filter, or convention modules.

## Design

### Tool Calls

`McpRuntime.callTool` should reject agent-originated calls that the role's tool
filter does not allow.

- If `ctx.operatorContext === true`, bypass role filtering.
- If `ctx` is present and not operator context, find the called tool and apply
  the existing `applyToolFilter(getToolFilter(ctx.role), tool)` decision.
- If `ctx` is missing, treat the call as an operator/runtime call only for
  known bootstrap/server paths that cannot be agent-originated; migrate those
  paths to pass explicit operator context.
- External MCP tools need an explicit decision. Either reject external tool calls
  from agent contexts until they can be authorized consistently, or document that
  external tool authorization is limited to the agent-visible schema layer. The
  preferred simple v2 default is to reject agent-originated external calls unless
  an operator path invokes them.
- Keep `BaseAgent.getToolSchemas()` as a presentation layer using the same
  `applyToolFilter` source; no code change is expected there unless tests reveal
  drift.

Specialized handler checks stay where they are:

- Knowledge ACL and scope checks stay in `src/knowledge/permissions.ts` and the
  knowledge handlers.
- RAG admin/control checks stay in the RAG service/handler because they depend
  on operation arguments and control mutex state.

### Path Mutations

`src/agents/conventions.ts` already enforces role-based path mutations at the tool
handler level. `write_file`, `download_file`, `download_with_fallbacks`,
`git_commit`, and explicit shell output paths all call `decidePathMutation()`,
which **blocks** writes that violate role territory and returns a structured error
to the agent.

This enforcement is a safety boundary, not a behavioral nudge. The active design
keeps it as hard refusal and does not soften it into a nudge.

Recommended changes to path enforcement:

- Keep existing blocking as-is. It is not a convention nudge — it is a safety
  boundary preventing agents from writing outside their territory.
- Migrate `process.env.PROJECT_ROOT` resolution in `decidePathMutation` to use
  injected `ProjectContext` when built-ins modularization lands.
- Preserve hard knowledge-store protection (`.saivage/skills/` and
  `.saivage/memory/`) as-is.

## Execution Plan

1. Migrate known runtime paths, especially PlanService's git commit callback in
   `src/server/bootstrap.ts`, to pass explicit `operatorContext: true`.
2. Update tests that call tools directly to use an explicit operator-context
   helper when they are not testing agent authorization.
3. Add role/tool enforcement to `McpRuntime.callTool` using
   `applyToolFilter` and `getToolFilter`; do not add a new policy table.
4. Decide and implement the external-MCP behavior: reject agent-originated
   external calls by default, or document any narrower exception.
5. Change `conventions.ts` to return an enforceable path decision derived from
   `ROSTER[*].convention`.
6. Update filesystem, data, shell-log-output, and git handlers to accept
   `ToolCallContext` where needed.
7. Wire the path decision into write/download/commit handlers.
8. Fold existing ad-hoc `.saivage/skills/` and `.saivage/memory/` write blocks
   into the same decision path.
9. Add tests for both tool denial and path denial.

## Validation

- `npm run typecheck`
- `npm test`
- Focused tests:
  - Planner cannot call shell through `McpRuntime.callTool`.
  - Reviewer cannot call `write_file` through direct runtime invocation.
  - Chat cannot call write/download tools.
  - Operator context can call runtime tools needed by bootstrap/server paths.
  - Coder can write source/test paths but not research paths.
  - Researcher can write research paths but not source paths.
  - Data Agent can write data/provenance paths but not source paths.
  - Direct writes under `.saivage/skills/` and `.saivage/memory/` remain blocked
    for agents.

## Risks

- Shell access can still mutate broadly. This is intentional: shell is a
  high-trust tool and should be restricted by role/tool filtering rather than
  approximated by parsing shell strings.
- Existing tests may rely on context-free direct tool calls. Fix tests by making
  operator context explicit, not by weakening runtime enforcement.
