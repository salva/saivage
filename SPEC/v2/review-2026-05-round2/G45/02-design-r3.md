# G45 — Design r3

Round: 3 (writer: Claude Opus 4.7).
Prereq: [01-analysis-r3.md](./01-analysis-r3.md).
Prior rounds: [02-design-r1.md](./02-design-r1.md), [02-design-r2.md](./02-design-r2.md), [04-review-r1.md](./04-review-r1.md), [04-review-r2.md](./04-review-r2.md).

## Round-3 deltas vs r2

Only the validation-gate design changes. The structural recommendation (Proposal A, manual rewrite) and the section-by-section content described in [02-design-r2.md](./02-design-r2.md#L31-L82) are unchanged and re-confirmed by review r2.

What changes is the *pass/fail rule* attached to the rewrite:

- Review r2 found that the r2 gate listed `-e '"stopped"'` as a forbidden literal while the design simultaneously kept a one-line disclaimer of the form `There is no "stopped" runtime status` in the rewritten doc. That makes the gate non-deterministic.
- r3 resolves this by deleting the broad bare `"stopped"` token from the gate and the disclaimer prose from the doc. The gate becomes a strict zero-match check again, with no carve-outs and no exception that the reviewer must hand-verify.

## Approach options considered

The r2 review explicitly proposed three repairs. Each evaluated below.

### Option 1 — Scope the gate to interface / return-type blocks only, allow `"stopped"` in prose

Mechanism: change the grep from a file-wide `rg -n -F` to a structural check (e.g. extract fenced `ts` blocks, run `rg -F` over those only) so the disclaimer prose in markdown text outside the code fences is exempt.

Why rejected:

- Requires writing or sourcing a fence-aware extractor. That is more code than the entire docs fix it gates, and the project rule "no regex for user intent" makes a brace-matching extractor explicitly off the table. A correct extractor is a small parser, not a one-liner.
- The whole point of the gate is to be trivially auditable in code review. A bespoke extractor moves the audit surface from "did `rg -F` return zero lines" to "did our extractor correctly identify the code fences?", which is worse.
- This option also keeps a disclaimer in the doc that exists only to apologise for a stale claim that the doc never makes any more. That is editorial dead weight.

### Option 2 — Remove the explanatory `"stopped"` token from the doc; keep the broad gate

Mechanism: in the rewritten doc, state only the truth (`"idle"`) and link to [docs/internals/abort-recovery.md](../../../../docs/internals/abort-recovery.md) for the persisted-state schema. Do not mention `"stopped"` at all. Drop the bare `"stopped"` literal from the gate too, because if the doc never names the token, the broad search would have nothing to match anyway and is then either redundant or, worse, a tripwire for unrelated future prose (e.g. an event-name string like `"stopped"` for a Fastify listener).

Why selected: this is the architecture-first minimal-diff outcome.

- Smallest possible change to the r2 plan: one literal removed from the gate, one disclaimer sentence removed from Step 6.
- The gate keeps its property of "literal forms only, zero matches = pass" with no extraction, no prose carve-out, and no reviewer judgement call.
- The doc gets shorter, not longer. The reader is told the truth (`"idle"`) and pointed at the canonical schema page for the full state machine. Apologetic prose about a token that does not appear in the current schema is unnecessary.
- It honours the workspace rule "actively REMOVE code supporting old features/structures rather than keeping migration shims" — the `"stopped"` disclaimer is exactly the kind of vestigial back-reference the rule is aimed at.

### Option 3 — Split the gate into an interface-region grep plus a prose-allow-list

Mechanism: two sequential checks. First, an `rg -F -e 'status: "stopped"'` over the whole file (still strict zero matches). Second, a separate `rg -c '"stopped"'` over the whole file with an allow-list of exactly the disclaimer sentence.

Why rejected:

- Re-introduces a reviewer-judgement step ("does the matched line literally equal the allowed sentence?"). That is the exact failure mode review r2 flagged.
- Requires either (a) maintaining a fixed disclaimer string in two places (the doc and the gate's allow-list) — a duplication that will drift, or (b) checking line counts (`-c 1`) — which is a heuristic, not a verification.
- Buys nothing Option 2 does not give us, at strictly higher complexity.

## Selected approach: Option 2

The r3 gate, in full, is:

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

Compared to the r2 list, exactly one literal — bare `'"stopped"'` — is removed. The `status: "stopped"` form (the actual stale TS/JSON shape in the current doc at [docs/internals/server.md](../../../../docs/internals/server.md#L76)) is retained, so the original drift cannot reappear.

The rewritten "`runtime.shutdown()`" subsection in [docs/internals/server.md](../../../../docs/internals/server.md) loses its disclaimer sentence. The relevant step in the subsection now reads (in source order, sourced from [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L229-L245)):

> 6. `writeRuntimeState(..., { status: "idle" })` — the persisted on-disk status. See [docs/internals/abort-recovery.md](../../../../docs/internals/abort-recovery.md) for the full runtime-state schema.

That is the only sentence the reader needs. No counterfactual.

## Acceptance criteria (replaces r2 acceptance)

The acceptance criteria in [02-design-r2.md](./02-design-r2.md#L120-L125) carry over, with the following edits to keep them consistent with the r3 gate:

- The three sections cited in G45 (interface block, `startServer` signature, graceful-shutdown list) match the real TS at the cited line numbers when the PR lands.
- No field on the runtime block is missing from `SaivageRuntime` in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) and vice versa.
- The shutdown section explicitly attributes each step to either the CLI command (`serve`) or `runtime.shutdown`.
- `npm run docs:build` passes.
- The grep gate from §"Selected approach: Option 2" above returns **zero** matches against the rewritten [docs/internals/server.md](../../../../docs/internals/server.md). There is no documented exception, no per-line carve-out, and no PR-description hand-verification. Zero matches is the only passing outcome.
- The rewritten doc must not contain a sentence whose only purpose is to inform the reader that `"stopped"` is not a status. Saying the persisted status is `"idle"` and linking to [docs/internals/abort-recovery.md](../../../../docs/internals/abort-recovery.md) is sufficient.

## Risks and how to control them

The r2 risks carry over verbatim. One additional risk specific to r3:

- Risk: a future PR re-adds a disclaimer about `"stopped"` for what feels like reader-friendliness, and the gate (which no longer flags bare `"stopped"`) does not catch it. Control: the `status: "stopped"` literal *is* still gated, so the original drift (the field/JSON form) remains caught; harmless prose mentions are intentionally allowed. If a future review round shows the disclaimer pattern recurring, escalate the gate then — do not preemptively complicate it now.

## Out of scope

Same as r2: auto-rendering the interface from source (Proposal B), and the supervisor / abort-recovery doc sweeps the reviewer noted are tracked separately under the round-2 metaplan.
