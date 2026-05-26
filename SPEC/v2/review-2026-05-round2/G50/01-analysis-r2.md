# G50 — Analysis (Round 2)

**Issue**: [../G50-note-manager-per-request-instantiation.md](../G50-note-manager-per-request-instantiation.md)
**Round 1**: [01-analysis-r1.md](01-analysis-r1.md)
**Round 1 review**: [04-review-r1.md](04-review-r1.md)
**Subsystem**: server / runtime (notes)
**Severity**: low (design smell, latent correctness risk)

Round 2 carries the round-1 analysis forward unchanged in substance and
adds two clarifications the round-1 review asked for: a complete
enumeration of live `AgentContext` construction sites, and a sharpened
statement of what the regression test must prove.

## 1. What the issue says (unchanged from r1)

`NoteManager` is constructed ad hoc by every consumer that needs notes
on disk:

- Four `/api/notes*` Fastify handlers each `new` a fresh instance
  ([src/server/server.ts](../../../../src/server/server.ts#L256), [src/server/server.ts](../../../../src/server/server.ts#L262), [src/server/server.ts](../../../../src/server/server.ts#L272), [src/server/server.ts](../../../../src/server/server.ts#L280)).
- Bootstrap builds a one-shot cleanup instance at
  [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L193).
- The Planner builds yet another in its constructor at
  [src/agents/planner.ts](../../../../src/agents/planner.ts#L52) and wraps it in a `NoteChannel`
  ([src/agents/planner.ts](../../../../src/agents/planner.ts#L63)).

`SaivageRuntime` ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66)) does not surface a
shared manager, so each call site rebuilds one from
`project.paths.notes`.

## 2. Why the contract is wrong (unchanged from r1)

`NoteManager` carries `delivered: Set<string>` ([src/runtime/notes.ts](../../../../src/runtime/notes.ts#L60))
that gates `pullDeliverables` ([src/runtime/notes.ts](../../../../src/runtime/notes.ts#L75-L88)) and is
cleared by `resetDelivered()` after compaction
([src/runtime/notes.ts](../../../../src/runtime/notes.ts#L91-L93)). The exported contract today says
"construct anywhere, no shared state"; the implementation contradicts
that the moment any consumer touches the delivered cursor (Planner
does). The first cache / debouncer / inotify watcher silently splits
the world into per-handler caches. See r1 §2 for the longer argument.

## 3. AgentContext construction sites — full live audit

Round 1 said "all `AgentContext` builders necessarily have access to
runtime / project; threading `noteManager` through them is local." The
round-1 review flagged this as under-enumerated. A fresh
`rg -n "AgentContext" src/` shows every live construction site —
i.e. every place that materialises an `AgentContext` literal or an
explicit `as AgentContext` value, not merely the places that consume a
context that was built upstream.

### 3.1 Production sites (must be wired to `runtime.noteManager`)

1. [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L293) — `createChildSpawner` builds
   `const ctx: AgentContext = { project, router, mcpRuntime, agentId,
   role, ...resolveAgentRoute(runtime, role) }`. Every child agent
   (manager, coder, researcher, data_agent, reviewer, designer,
   inspector) is created from this literal.
2. [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L486) — `runPlanner` builds the
   `const ctx: AgentContext = { … }` literal used by
   `PlannerAgent.create(ctx, …)`. This is the literal the Planner reads
   `ctx.noteManager` from in the design.
3. [src/server/server.ts](../../../../src/server/server.ts#L672) — `/ws` WebSocket handler builds an
   untyped `ctx = { project, router, mcpRuntime, agentId, role: "chat",
   channelId, sessionId, ...resolveChatRoute(runtime) }` and passes it
   to `ChatAgent.create(ctx, …)`. This was not enumerated in r1.
4. [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts#L72) — Telegram per-chat handler
   builds an untyped `ctx = { project, router, mcpRuntime, agentId,
   role: "chat", channelId, sessionId, ...resolveChatRoute() }` and
   passes it to `ChatAgent.create(ctx, …)`. Same shape as `/ws`. This
   was not enumerated in r1.
5. [src/server/cli.ts](../../../../src/server/cli.ts#L241) — CLI inspector dispatch builds an
   untyped `ctx = { project, router, mcpRuntime, agentId, role:
   "inspector", modelSpec, authProfileKey, accountRef }` and passes it
   to `InspectorAgent.create(ctx, …)`. This was not enumerated in r1.

All five literals must set `noteManager: runtime.noteManager`. The
three previously-missing sites (`server.ts /ws`, `telegram-bot.ts`,
`cli.ts inspect`) are untyped object literals; making the field
required on `AgentContext` will force them to compile-fail until they
are wired, which is the desired behaviour.

### 3.2 Test sites (must compile with the new shape)

These build `AgentContext` literals via test helpers and pass them to
agent factories. With `noteManager` becoming required on `AgentContext`,
each must add a stub `NoteManager` (pointed at a tmpdir) or a small
fake; otherwise the test file will not type-check.

1. [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L569) — `makeReviewerContext(...)`
   returns `AgentContext`.
2. [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L614) — `makeChatContext(...)` returns
   `AgentContext`.
3. [src/agents/chat.lifecycle.test.ts](../../../../src/agents/chat.lifecycle.test.ts#L53) — `makeContext(...)`
   returns `AgentContext`.
4. [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L28) —
   `makePlannerContext(...)` returns `AgentContext`.
5. [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts#L43) — local helper
   returning `AgentContext`.
6. [src/agents/conversation-snapshot.test.ts](../../../../src/agents/conversation-snapshot.test.ts#L45) —
   `makeContext(router)` returns `AgentContext`.

These are mechanical wiring updates: each helper already has access to
the tmpdir it uses for `project.paths.notes`, so the stub manager is a
one-line `new NoteManager(notesDir)`.

### 3.3 Consumption-only sites (no change)

The other `AgentContext` mentions found by `rg` are consumption-only:
parameter types in agent factories (`ctx: AgentContext` in
[src/agents/base.ts](../../../../src/agents/base.ts#L168), [src/agents/manager.ts](../../../../src/agents/manager.ts#L29), [src/agents/worker.ts](../../../../src/agents/worker.ts#L44),
[src/agents/coder.ts](../../../../src/agents/coder.ts#L17), [src/agents/researcher.ts](../../../../src/agents/researcher.ts#L17),
[src/agents/designer.ts](../../../../src/agents/designer.ts#L17), [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts#L16),
[src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L19), [src/agents/inspector.ts](../../../../src/agents/inspector.ts#L26),
[src/agents/chat.ts](../../../../src/agents/chat.ts#L59), [src/agents/planner.ts](../../../../src/agents/planner.ts#L32),
[src/agents/handoff.ts](../../../../src/agents/handoff.ts#L19),
[src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L30)) and helper signatures
([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L769) `resolveAgentRoute(...)`). These
do not construct contexts; they receive them, so threading the new
field is automatic.

## 4. What the regression test must prove

Round 1's "multi-request" test asserted `runtime.noteManager === runtime.noteManager`
and ran `pullDeliverables()` on that same reference. The round-1 review
correctly observed that this passes even if the `/api/notes*` handlers
keep doing `new NoteManager(runtime.project.paths.notes)` — the
runtime property is never read by the handlers in that scenario.

The round-2 regression test must drive real HTTP requests against the
`/api/notes*` handlers and observe behaviour that is only possible if
the handlers reach into `runtime.noteManager`:

- Either install a `vi.spyOn(runtime.noteManager, "listNotes")` and
  assert the spy is called at least once per `GET /api/notes` (a fresh
  per-handler `new NoteManager(...)` cannot trigger this spy because
  the spy is attached to the runtime-owned instance only); or
- Observe `delivered` Set state surviving across requests: after the
  first request causes `runtime.noteManager.delivered.add("X")`, a
  second request reads `runtime.noteManager.delivered.has("X") === true`.
  A per-handler `new NoteManager(...)` would never inherit that entry
  because each construction starts with an empty `Set`.

The plan adopts the spy-on-shared-instance variant: it is observable
through any handler that calls a `NoteManager` method (so all four
handlers can be covered), and it does not require leaking the
`delivered` cursor into a public test helper.

For dispatch, the test uses Fastify's `app.inject()` — a real HTTP
request through the same router pipeline production uses — driven
against a Fastify instance produced by a small `registerNotesRoutes`
factory split out of `startServer`. That keeps the test from booting
the full runtime (no MCP, no providers, no tracker) while still
exercising the actual handler code paths.

## 5. Scope, out-of-scope, files implicated

Unchanged from r1 (analysis §4, §5, §6). The fix is bounded: one
construction in bootstrap, one field on `SaivageRuntime`, one field on
`AgentContext`, five live context literals updated, four HTTP handlers
collapsed, one Planner constructor cleaned up. Atomic
`acknowledgeNote`, in-process caches, and watchers stay out of scope.
