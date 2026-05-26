# G41 — `App.vue` document-title sync reads non-existent fields from `/api/state`

- **Subsystem**: web UI (`web/src/App.vue`)
- **Category**: bug, silent regression of schema contract
- **Severity**: medium
- **Transversality**: local to `App.vue`, but rooted in the same `/api/state`
  schema confusion as G40

## Summary

`pollTitleStatus` in `App.vue` reads `data.status`, `data.phase`, and
`data.currentStage?.id` out of the `/api/state` response. The endpoint actually
returns `{ state, plan }` (with the runtime fields nested inside `state`), so
every field is `undefined` and the `<title>` element silently never updates
from its initial value.

## Evidence

`App.vue` title poller — reads top-level fields:

```ts
const data = await response.json();
const status = data.status as string | undefined;
const phase = data.phase as string | undefined;
const stageId = data.currentStage?.id as string | undefined;
```

[web/src/App.vue](web/src/App.vue#L121-L138)

`GET /api/state` actually returns `{ state, plan }`:

```ts
fastify.get("/api/state", async () => {
  const state = await runtime.tracker.read();
  const plan = await runtime.planService.readPlan();
  return { state, plan };
});
```

[src/server/server.ts](src/server/server.ts#L171-L177)

`RuntimeState` (what `state` actually contains) exposes `status`,
`current_stage_id`, `active_agents` — there is no `phase` or `currentStage`
anywhere:

[src/types.ts](src/types.ts#L248-L275)

Compare to `AgentsView.vue`, which uses the correct shape:

```ts
const data = await response.json();
agents.value = data.state?.active_agents ?? [];
```

[web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L135-L140)

## Why this matters

The browser tab title is the operator's at-a-glance health indicator across
multiple windows. It's supposed to flip between *"Saivage — running stg-…"*,
*"Saivage — paused"*, *"Saivage — error"*, etc. Today it always shows the
initial string regardless of runtime state, because the JSON access path is
wrong. The bug is invisible (no console error, no 4xx — `undefined` just
falls through every branch) and trivially testable, but nobody has noticed
because the wrong field names happen to be readable property accesses on a
defined object.

## Rough remediation direction

Change the three reads to `data.state?.status`, drop the non-existent `phase`
field, and switch to `data.state?.current_stage_id` (note snake_case — the
on-disk runtime state uses snake_case throughout, see
[src/types.ts](src/types.ts#L248-L275)).

**Level up**: stop hand-typing API response shapes inside Vue components.
Generate a shared `ApiTypes` module (e.g. `web/src/api/types.ts`) from the
server's Zod schemas, and have both the Fastify handler and the SPA consume
it. This same root cause feeds G40 (the docs hand-typed a different shape) and
will keep producing silent bugs every time someone reshapes `/api/state`.

## Cross-links

- G40 — `/api/state` is documented with a third, different shape in
  `docs/guide/web-ui.md`.
- F26 — SPA auth-state duplication (title sync is one of the two places that
  reacts to `/api/state` 401s).
