# G41 — Analysis (r2)

## Functional analysis

`App.vue` owns one of two cross-cutting SPA concerns that keep the browser-tab
title in sync with the runtime (the other is the unauthorized banner). The tab
title is what an operator scans across multiple windows to know which Saivage
instance is running, paused, or in error; the contract is "the document title
must reflect what the daemon last wrote to `.saivage/runtime-state.json`".

The *watch + render* half of the implementation honors that contract: the
watch at [web/src/App.vue](web/src/App.vue#L155-L166) consumes the refs
`runtimeStatus` and `runtimeStage`, prepends "Saivage", optionally injects
the `⚠ unauthorized` token from `useAuthState`, and appends the active tab
label. That code is correct.

It is broken by the *poll + assign* half: `pollTitleStatus` at
[web/src/App.vue](web/src/App.vue#L126-L143) reads the JSON returned by
`/api/state` as if it were a flat `RuntimeState`:

- `data.status`
- `data.phase`
- `data.currentStage?.id`

The endpoint at [src/server/server.ts](src/server/server.ts#L173-L180)
returns the two-key envelope `{ state, plan }`. `state` is `RuntimeState` as
declared at [src/types.ts](src/types.ts#L251-L259):

- `status: "idle" | "running" | "suspended" | "error"`
- `current_stage_id: string | null`
- `active_agents: AgentState[]`
- `started_at: string`
- `updated_at: string`
- `pid: number`

So all three reads in `pollTitleStatus` resolve to `undefined`:

| Read | Truth |
|---|---|
| `data.status` | does not exist; runtime status lives at `data.state.status` |
| `data.phase` | no such field anywhere in the Zod schema |
| `data.currentStage?.id` | does not exist; the stage id lives at `data.state.current_stage_id` (snake_case, string \| null) |

The downstream coalescing `(data.status ?? data.phase ?? "").toString()` makes
the bug invisible: `undefined ?? undefined ?? ""` returns the empty string,
which is a legitimate value for `runtimeStatus`. The watch fires once with
`["Saivage", "· Dashboard"]` and never again. No HTTP error, no console
warning, no 401 — the title is just stuck on its initial composition for the
life of the page.

This is the same root cause as G40 (the operator doc invented a third
`/api/state` shape) and the same root cause as the bug fixed already in
[web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L141-L143)
(which reads correctly: `data.state?.active_agents ?? []`). G45 captures the
parallel drift in the internals doc. Three documents, two SPA components, one
server file — four hand-typed shapes for the same payload.

## Inline-typed-shape inventory

Every SPA file that reads a `/api/state` derivative hand-types its own
approximation:

- [web/src/App.vue](web/src/App.vue#L126-L143) — wrong (this finding).
- [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L12-L18) declares its own `AgentState` and consumes `data.state?.active_agents` correctly at [L141-L143](web/src/components/AgentsView.vue#L141-L143).
- [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L10-L48) declares its own `AgentState`, `RuntimeState`, `Stage`, `Plan`, and `HistoryEntry`. Reads `/api/state` correctly via local typing.
- [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L9-L23) declares its own `Stage` and `Plan` (also a local `HistoryEntry` farther down).

A grep over `web/src/` for `interface RuntimeState`, `interface Plan`,
`interface AgentState`, and `interface Stage` returns six independent
re-declarations of these four shapes, all duplicating the Zod schemas at
[src/types.ts](src/types.ts#L34-L48) and [src/types.ts](src/types.ts#L241-L259).
Whoever next reshapes `/api/state` has to find and edit all of them; the
title-sync regression is what happens when the search misses one.

## Stage shape — canonical schema versus the local copies

The reviewer of r1 flagged that any shared `PlanStage` must mirror the full
canonical `StageSchema` at [src/types.ts](src/types.ts#L34-L42):

```ts
export const StageSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1).max(1000),
  starting_points: z.array(z.string()),
  expected_outcomes: z.array(z.string()).min(1),
  acceptance_criteria: z.array(z.string()).min(1),
  references: z.array(z.string()),
  tags: z.array(z.string()),
});
```

All seven fields are required; the array fields are required arrays, not
optional. The local `Stage` in
[web/src/components/PlanView.vue](web/src/components/PlanView.vue#L9-L17)
marks five of them optional with `?:`, and the local `Stage` in
[web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L29-L33)
collapses the schema to just `id`, `objective`, and optional `tags`. The
canonical shape that the shared module exports must be the full required-arrays
shape; the optional chains in PlanView's template (`stage.expected_outcomes?.length`)
remain valid TypeScript against the wider canonical type and need no rewrite.

## Plan history is a different route, with a different schema

The local `HistoryEntry` declarations in
[web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L42-L48)
and PlanView are not part of `/api/state`. They are partial readings of
`CompletedStageSchema` from [src/types.ts](src/types.ts#L56-L77), reached via
`/api/plan-history`. They are outside G41's scope: `pollTitleStatus` does not
read `/api/plan-history`, and the canonical `CompletedStage` is a much larger
shape (escalation, abort_reason, started_at, etc.) than what either component
currently reads. The shared module introduced by G41 covers `/api/state`
only; `HistoryEntry` stays local in StatusPanel until a future finding
centralizes plan-history consumers as well.

## AgentState.agent_type narrowing

`AgentStateSchema` at [src/types.ts](src/types.ts#L242-L249) declares
`agent_type: z.enum(ALL_ROLES)`, with `ALL_ROLES` derived from the nine-entry
`ROSTER` in [src/agents/roster.ts](src/agents/roster.ts#L41-L211). The local
`AgentState` interfaces in AgentsView and StatusPanel both widen this to
`string`, losing the narrowing. The shared module should mirror the canonical
literal union (nine literals, hand-written, with a short comment pointing at
roster.ts). Drift risk is minimal — the roster has been stable for many
revisions, and any change there breaks the server typecheck immediately,
which is the same forcing function that already keeps `RuntimeStateSchema`
honest.

## Why this matters beyond a three-line fix

- **Schema drift is the recurring failure mode.** G40 (operator doc), G45
  (internals doc), and G41 (`App.vue`) are three instances of the same defect
  class against the same `/api/state` schema. The Zod schema in
  [src/types.ts](src/types.ts#L34-L48) and [src/types.ts](src/types.ts#L241-L259)
  is the only place provably in sync with the daemon; everything else is a
  hand-copied subset.
- **Silent failures are worse than loud ones.** A 401 surfaces an
  unauthorized banner. A 404 surfaces a fetch error. Reading `undefined`
  surfaces nothing — the operator notices the tab title looks stale, or
  never. F26's auth-state composable lit up the same observation: silent SPA
  drift is the residual category to flag.
- **No backward-compat constraint applies.** The wire format is server-owned,
  the SPA is the only consumer, and the `phase` field has never existed on
  the wire — there is no historical revision of `/api/state` that returned a
  flat `{ status, phase, currentStage }` payload. The fix is mechanical.

## Validation reality: the web build is Vite-only

The reviewer of r1 also flagged that the round-1 plan claimed `npm run build`
runs `vue-tsc`. It does not. The current scripts:

- Root [package.json](package.json#L13-L14): `"build": "npm run build:web && tsup"`, `"build:web": "cd web && npm run build"`.
- Web [web/package.json](web/package.json#L8): `"build": "vite build"`.
- Root [tsconfig.json](tsconfig.json#L20-L21): `include: ["src/**/*.ts"]`, `exclude: [..., "web", "**/*.test.ts"]`.
- Web [web/tsconfig.json](web/tsconfig.json#L1-L19): exists, `noEmit: true`, includes `.vue` files, but no `tsc -p web` is wired into any npm script and `vue-tsc` is not installed.

So the bare `vite build` is the only check that runs today, and it does not
type-check Vue SFC `<script setup>` blocks. The G41 plan must either add a
real web type-check (`vue-tsc --noEmit -p web/tsconfig.json` as a `typecheck`
script + devDependency) or stop claiming type safety it cannot deliver. The
r2 design and plan choose to add `vue-tsc` as a one-line devDep and a one-line
script — the architecture-first move, because the new shared module is only
load-bearing if the consumers are actually type-checked against it.

## Bug-vs-design boundary

The narrowly-scoped bug is three lines in `pollTitleStatus`; fixing those
three lines restores the contract. The architectural finding underneath is
that the SPA has no shared types module mirroring [src/types.ts](src/types.ts),
so every component that reads a Saivage API redoes the same hand-typing
exercise. The design phase weighs the trade-off between a point-fix that
leaves the drift surface intact and a small shared-types module that removes
it for the routes the SPA actually consumes — and, because the only mechanism
that holds that module honest is a real Vue type-checker, it also weighs the
cost of wiring `vue-tsc` into the web build.

## Cross-finding links

- **G40** — operator doc has a third `/api/state` shape; lands a doc rewrite
  asserting the `{state, plan}` envelope. Orthogonal to G41.
- **G45** — `docs/internals/server.md` documents a `SaivageRuntime` shape
  that drifted from the runtime; same root cause class.
- **F26** — already shipped `useAuthState`; that composable is the model
  for centralising other repeated SPA concerns (here: API response shapes).
- **G46** — `AgentsView.vue` monolith; if/when it gets refactored it will
  inherit the shared types module instead of re-introducing duplicate
  interfaces.
