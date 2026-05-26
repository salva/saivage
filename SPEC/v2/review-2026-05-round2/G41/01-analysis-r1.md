# G41 — Analysis (r1)

## Functional analysis

`App.vue` owns one of two cross-cutting SPA concerns that have to keep the
browser-tab title in sync with the runtime (the other is the unauthorized
banner). The tab title is what an operator scans across multiple windows to
know which Saivage instance is running, paused, or in error; the contract is
"the `<title>` must reflect what the daemon last wrote to
`.saivage/runtime-state.json`".

That contract is honored by the *watch + render* half of the implementation:
the [watch in App.vue](web/src/App.vue#L155-L166) consumes the two refs
`runtimeStatus` and `runtimeStage`, prepends `"Saivage"`, optionally injects
the `⚠ unauthorized` token from `useAuthState`, and appends the current tab
label. That code is correct.

It is broken by the *poll + assign* half: `pollTitleStatus` at
[web/src/App.vue](web/src/App.vue#L126-L143) reads the JSON returned by
`/api/state` as if it were a flat `RuntimeState`:

- `data.status`
- `data.phase`
- `data.currentStage?.id`

The endpoint at
[src/server/server.ts](src/server/server.ts#L173-L180) returns the
two-key envelope `{ state, plan }`:

```ts
app.get("/api/state", async () => {
  const [state, plan] = await Promise.all([
    readDocOrNull(runtime.project.paths.runtimeState, RuntimeStateSchema),
    readDocOrNull(runtime.project.paths.plan, PlanSchema),
  ]);
  return { state, plan };
});
```

`state` is `RuntimeState` as declared at
[src/types.ts](src/types.ts#L251-L259):

```ts
export const RuntimeStateSchema = z.object({
  status: z.enum(["idle", "running", "suspended", "error"]),
  current_stage_id: z.string().nullable(),
  active_agents: z.array(AgentStateSchema),
  started_at: z.string(),
  updated_at: z.string(),
  pid: z.number(),
});
```

So all three reads in `pollTitleStatus` resolve to `undefined`:

| Read | Truth |
|---|---|
| `data.status` | does not exist; runtime status lives at `data.state.status` |
| `data.phase` | **no such field anywhere in the schema** |
| `data.currentStage?.id` | does not exist; the stage id lives at `data.state.current_stage_id` (string \| null, snake_case) |

The downstream coalescing `(data.status ?? data.phase ?? "").toString()` makes
the bug invisible: `undefined ?? undefined ?? ""` returns the empty string,
which is a legitimate value for `runtimeStatus`, so the watch fires once with
`["Saivage", "· Dashboard"]` and never again. No HTTP error, no console
warning, no 401 — the title is just stuck on its initial composition for the
life of the page.

This is the same root cause as G40 (the operator doc invented a third
`/api/state` shape) and the same root cause as the bug fixed already in
[web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L141-L143)
(which does the read correctly: `data.state?.active_agents ?? []`). G45
captures the parallel drift in the internals doc. Three documents, two SPA
components, one server file — four hand-typed shapes for the same payload.

## Inline-typed-shape inventory

Every SPA file that reads `/api/state` hand-types its own approximation:

- [web/src/App.vue](web/src/App.vue#L126-L143) — wrong (this finding).
- [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L12-L18)
  declares its own `AgentState` interface and consumes `data.state?.active_agents`
  correctly at [L141-L143](web/src/components/AgentsView.vue#L141-L143).
- [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L10-L42)
  declares its own `AgentState`, `RuntimeState`, `Stage`, `Plan`,
  `HistoryEntry`. Reads `/api/state` correctly via local typing.

A workspace grep `grep -rn "interface RuntimeState\|interface Plan\b\|interface AgentState" web/src/`
returns three independent re-declarations of `AgentState`, two of `Plan`, one
of `RuntimeState` — all duplicating the server's Zod schemas at
[src/types.ts](src/types.ts#L241-L259). Whoever next reshapes `/api/state` has
to find and edit all of them; the title-sync regression is what happens when
the search misses one.

## Why this matters beyond a three-line fix

- **Schema drift is the recurring failure mode.** G40 (operator doc), G45
  (internals doc), and G41 (`App.vue`) are three instances of the same defect
  class against the same `/api/state` schema. The Zod schema in
  [src/types.ts](src/types.ts#L241-L259) is the only place that is provably
  in sync with the daemon; everything else is a hand-copied subset.
- **Silent failures are worse than loud ones.** A 401 surfaces an
  unauthorized banner. A 404 surfaces a fetch error. Reading `undefined`
  surfaces nothing — the operator finds out by noticing the tab title looks
  stale, or never. F26's auth-state composable lit up the same observation:
  silent SPA drift is the residual category to flag.
- **No backward-compat constraint applies.** The wire format is server-owned,
  the SPA is the only consumer, and the `phase` field has never existed on
  the wire — there is no historical revision of `/api/state` that returned
  a flat `{ status, phase, currentStage }` payload. The fix is mechanical.

## Bug-vs-design boundary

The narrowly-scoped bug is three lines in `pollTitleStatus`; fixing those
three lines restores the contract. The architectural finding underneath is
that the SPA has no shared types module mirroring `src/types.ts`, so every
component that reads a Saivage API redoes the same hand-typing exercise.
The design phase weighs the trade-off between a point-fix that leaves the
drift surface intact and a small shared-types module that removes it for
the routes the SPA actually consumes.

## Cross-finding links

- **G40** — operator doc has a third `/api/state` shape; lands a doc
  rewrite that asserts the `{state, plan}` envelope. Orthogonal to G41
  (different file, different audience).
- **G45** — `docs/internals/server.md` documents a `SaivageRuntime` shape
  that drifted from the runtime; same root cause class.
- **F26** — already shipped `useAuthState`; that composable is the model
  for centralising other repeated SPA concerns (here: API response shapes).
- **G46** — `AgentsView.vue` monolith; if/when it gets refactored it will
  benefit from a shared types module to avoid re-introducing duplicate
  interfaces.
