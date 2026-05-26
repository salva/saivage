# G45 — APPROVED

**Chosen proposal**: Proposal A (per [02-design-r3.md](02-design-r3.md)) — surgical rewrite of three sections in docs/internals/server.md: the SaivageRuntime interface block (matches the real 13-field interface), the startServer signature (returns `{close}`, takes optional ServerOptions with default), and the bootstrap shutdown closure (7-step, not the 5-step serve teardown which belongs to cli.ts). Proposal B (build-time TS-snippet directive + docs lint) is queued as a batched level-up across G40/G44/G45 in the metaplan, rejected inside G45 itself per architecture-first scoping for a medium-severity docs fix.

**Approved by**: GPT-5.5 (copilot) reviewer at round 3 — see [04-review-r3.md](04-review-r3.md). All r2 blockers resolved via Option 2 (drop the broad bare `"stopped"` literal from the gate and remove the disclaimer sentence). Final gate is a strict zero-match rule with no carve-outs; field-form literal `status: "stopped"` remains gated so the original drift cannot reappear.

**Implementation pointer**: [03-plan-r3.md](03-plan-r3.md). Validation: refreshed source anchors verified against src/server/bootstrap.ts (SaivageRuntime 47-66, shutdown 229-245, createChildSpawner 281-287), src/server/server.ts (startServer return 723-727), src/cli.ts (serve shutdown 351-386); `npm run docs:build` gates the final state.

**Daemon impact**: Docs-only; no daemon restart required.
