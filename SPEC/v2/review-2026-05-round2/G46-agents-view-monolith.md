# G46 — `AgentsView.vue` is a 1,492-line monolith mixing agent list, chat sessions, conversation rendering, and round bucketing

- **Subsystem**: web UI (`web/src/components/AgentsView.vue`)
- **Category**: architecture / maintainability
- **Severity**: medium
- **Transversality**: every change to live agent UI, chat plumbing, or round
  rendering touches this one file

## Summary

`AgentsView.vue` is the largest Vue SFC in the web tree by an order of
magnitude. It owns four logically distinct surfaces — the live agent list,
chat session management, conversation/message rendering with round bucketing,
and the timeline view — all glued together by ~1,500 lines of `<script setup>`
state and template. The shared `<style scoped>` block is correspondingly
long. Edits in any of those four surfaces force every collaborator to reload
mental context for the other three, and the file has become the natural
attractor for "where do I put this new chat feature?" — which is exactly how
SFCs reach 1,500 lines.

## Evidence

```
$ wc -l web/src/components/AgentsView.vue
1492 web/src/components/AgentsView.vue
```

By contrast, the other tab views are roughly an order of magnitude smaller:

```
$ wc -l web/src/components/{Plan,Files,Debug,Status}*.vue web/src/components/ChatWindow.vue
…
675 web/src/components/ChatWindow.vue
…
```

(Even `ChatWindow.vue`, itself a candidate for splitting, is less than half
the size of `AgentsView.vue`.)

A read-through of [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L1-L200)
shows the `<script setup>` block alone holding state for at least:

- active agent polling (refs `agents`, `pollInterval`, polling fetch logic);
- chat session list (refs `sessions`, `selectedSessionId`, fetch + WS handler);
- round bucketing of conversation messages (round detection regex, render
  helpers);
- timeline / event coalescing logic;
- per-message formatting hooks (tool calls, errors, thinking traces).

Round-1 issue F18 ("system-prompt bloat") identified the same anti-pattern on
the server side (multi-hundred-line template literals); this is the SPA
mirror — a single SFC that has accumulated everything that touches "the
agents tab".

## Why this matters

Concrete drag on every nearby change:

- Conflict frequency: any two PRs touching the agents tab almost always
  conflict on this file.
- Test surface: testing one of the four surfaces in isolation is infeasible
  because they share refs, watchers, and template scope.
- Performance: the entire SFC re-evaluates `setup()` on tab switch; splitting
  lets Vue skip work on hidden sub-surfaces.
- Onboarding: a reader cannot get the gist of the agents view in one
  screenful.

This issue is also the structural reason G41 was easy to miss — when a single
SFC owns this much state, schema mismatches against the API don't surface
until the specific code path is exercised.

## Rough remediation direction

Split into a coordinator (`AgentsView.vue`, < 200 lines) + four siblings:

- `AgentList.vue` — owns the live agent panel and its polling composable.
- `ChatSessionList.vue` — owns the session sidebar.
- `ConversationView.vue` — owns the message rendering + round bucketing.
- `AgentTimeline.vue` — owns the time-ordered event view.

Lift cross-cutting state (selected session id, current round) into a small
Pinia store or a shared composable (`useAgentsViewState`). The coordinator's
template becomes a layout grid that slots in the four children.

**Level up**: this is the *visible* symptom of "no per-feature composable
extraction" across the SPA. Add an ESLint rule (or repo-level guideline) that
caps `.vue` files at, e.g., 400 lines, and require composables in
`web/src/composables/` for any non-trivial state machine. The same discipline
will prevent `ChatWindow.vue` (675 lines) from following this trajectory.

## Cross-links

- F18 — system-prompt bloat (analogous architectural rot on the server side).
- G41 — the title-sync schema bug; if `AgentsView` were smaller, the same
  schema mistake would not have lived in a sibling file unnoticed for as
  long.
