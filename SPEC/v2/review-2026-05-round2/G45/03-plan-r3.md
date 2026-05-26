# G45 — Implementation plan r3

Round: 3 (writer: Claude Opus 4.7).
Approach: Option 2 from [02-design-r3.md](./02-design-r3.md) (minimal-diff to r2: tighten the gate, drop the disclaimer).
Prior rounds: [03-plan-r1.md](./03-plan-r1.md), [03-plan-r2.md](./03-plan-r2.md), [04-review-r1.md](./04-review-r1.md), [04-review-r2.md](./04-review-r2.md).

## Round-3 deltas vs r2

Two surgical edits to the r2 plan; every other step in [03-plan-r2.md](./03-plan-r2.md) is unchanged and carried over.

1. **Step 5.2 (the `runtime.shutdown()` subsection rewrite) loses its disclaimer.** The r2 step 5.2 instructed the writer to render item 6 as `writeRuntimeState(..., { status: "idle" })` *and* to add a clarifying sentence in the form `"There is no "stopped" runtime status; …"`. r3 removes that clarifying sentence. Item 6 instead reads:

   > 6. `writeRuntimeState(..., { status: "idle" })` — the persisted on-disk status. See [docs/internals/abort-recovery.md](../../../../docs/internals/abort-recovery.md) for the full runtime-state schema.

   Likewise the bullet at the end of [02-design-r2.md §"Final shape after Proposal A"](./02-design-r2.md#L98-L99) that reads `Sentence appended: "There is no "stopped" runtime status; …"` is dropped. The link to [docs/internals/abort-recovery.md](../../../../docs/internals/abort-recovery.md) is sufficient.

2. **Step 7 (the final grep gate) drops the broad bare `"stopped"` token.** The r2 gate had two `"stopped"` literals (`status: "stopped"` and bare `"stopped"`). r3 keeps the precise field-form literal and removes the bare one. The bare literal was only there to defend against the disclaimer sentence the doc no longer contains; removing both at once is the architecture-first move and is the change that closes the r2 reviewer's blocker.

Both edits flow from the same design decision in [02-design-r3.md](./02-design-r3.md#L36-L57) and together restore an unambiguous zero-match gate.

## Carry-over scope and pre-work

Identical to [03-plan-r2.md §"Scope"](./03-plan-r2.md#L17) and §"Pre-work" — single-file edit to [docs/internals/server.md](../../../../docs/internals/server.md), pre-work greps unchanged.

One small refinement to the pre-work: the last bullet in §"Pre-work" of r2 ("Confirm `\"stopped\"` is *not* a legal value before writing that sentence into the doc") becomes "Confirm `\"stopped\"` is *not* a legal value of `RuntimeStateSchema` in [src/types.ts](../../../../src/types.ts); the writer must *not* introduce a sentence disclaiming it — the absence of the literal speaks for itself once the rewrite lands."

## Step-by-step edit (changes from r2)

Steps 1, 2, 3, 4, 6 are unchanged from [03-plan-r2.md §"Step-by-step edit"](./03-plan-r2.md#L36-L120). Repeat from there.

### Step 5 — Rewrite "Graceful shutdown" into two subsections

Carried from [03-plan-r2.md §"Step 5"](./03-plan-r2.md#L86) with the following narrow change to subsection 5.2.

#### 5.2 `runtime.shutdown()` (r3 wording)

Ordered list, sourced from [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L229-L245):

1. `tracker.freeze("shutdown")` — stops late agent-activity callbacks racing the final state write.
2. `writeShutdownSummary(project)` — best-effort.
3. `supervisor?.stop()`.
4. `mcpRuntime.shutdown()` — stops external MCP services.
5. `eventBus.clear()`.
6. `writeRuntimeState(..., { status: "idle" })` — the persisted on-disk status. See [docs/internals/abort-recovery.md](../../../../docs/internals/abort-recovery.md) for the full runtime-state schema.
7. `runtimeLock.release()`.

Append the same closing callout as r2: "`start` and `inspect` invoke `runtime.shutdown()` directly with no Fastify / Telegram steps — that wrapping is owned only by `serve`."

Do **not** add any sentence whose subject is the token `"stopped"`. The truth (`"idle"`) plus the schema link is the contract.

### Step 7 — Final grep gate (r3 form)

Run, scoped to [docs/internals/server.md](../../../../docs/internals/server.md):

```
rg -n -F \
  -e 'runtime.bus' \
  -e 'runtime.mcp' \
  -e 'runtime.spawn' \
  -e 'runtime.abort' \
  -e 'bus: EventBus' \
  -e 'mcp: McpRuntime' \
  -e 'spawn: ChildSpawner' \
  -e 'abort(reason' \
  -e '{ stop(): Promise<void> }' \
  -e 'stop(): Promise<void>' \
  -e 'status: "stopped"' \
  docs/internals/server.md
```

Diff from r2: the line `-e '"stopped"' \` is removed. The retained `-e 'status: "stopped"' \` continues to catch the actual stale form at [docs/internals/server.md](../../../../docs/internals/server.md#L76).

The pass rule is strict and singular: the gate must return **zero** matches. There is no documented exception, no allow-list, no PR-description hand-verification. If a line matches, the PR is not ready.

Per-literal justification, unchanged from r2 except where noted:

- `runtime.bus|mcp|spawn|abort` — dotted references inherited from r1; defence-in-depth against future prose introducing them.
- `bus: EventBus`, `mcp: McpRuntime`, `spawn: ChildSpawner`, `abort(reason` — the bare TS field declarations currently at [docs/internals/server.md](../../../../docs/internals/server.md#L28-L33).
- `{ stop(): Promise<void> }` and `stop(): Promise<void>` — the fictional `startServer` return shape at [docs/internals/server.md](../../../../docs/internals/server.md#L46).
- `status: "stopped"` — the wrong persisted-status sentence at [docs/internals/server.md](../../../../docs/internals/server.md#L76).
- *(removed in r3)* bare `"stopped"` — dropped because the rewritten doc no longer mentions the token, so the precise field-form literal is the only one that can legitimately fail.

## Validation

Identical to [03-plan-r2.md §"Validation"](./03-plan-r2.md#L168-L173).

## Out of scope, risks, estimated diff size

Carried over verbatim from [03-plan-r2.md](./03-plan-r2.md#L175-L195). The net diff in [docs/internals/server.md](../../../../docs/internals/server.md) is one line smaller than r2 estimated (the deleted disclaimer sentence); call it roughly +39 / −30 lines.
