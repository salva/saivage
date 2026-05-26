# G30 — Review r1

## Reviewer

GitHub Copilot

## Documents reviewed

- [SPEC/v2/review-2026-05-round2/G30-builtins-filesystem-sync-fs.md](SPEC/v2/review-2026-05-round2/G30-builtins-filesystem-sync-fs.md#L1-L45)
- [SPEC/v2/review-2026-05-round2/G30/01-analysis-r1.md](SPEC/v2/review-2026-05-round2/G30/01-analysis-r1.md#L1-L139)
- [SPEC/v2/review-2026-05-round2/G30/02-design-r1.md](SPEC/v2/review-2026-05-round2/G30/02-design-r1.md#L1-L215)
- [SPEC/v2/review-2026-05-round2/G30/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G30/03-plan-r1.md#L1-L279)
- Round-1 reference: [SPEC/v2/review-2026-05/F22/02-design-r2.md](SPEC/v2/review-2026-05/F22/02-design-r2.md#L1-L260), [SPEC/v2/review-2026-05/F22/03-plan-r2.md](SPEC/v2/review-2026-05/F22/03-plan-r2.md#L1-L260), [SPEC/v2/review-2026-05/F22/04-review-r2.md](SPEC/v2/review-2026-05/F22/04-review-r2.md#L1-L83)
- Spot checks: [src/mcp/builtins.ts](src/mcp/builtins.ts#L15-L26), [src/mcp/builtins.ts](src/mcp/builtins.ts#L226-L304), [src/mcp/builtins.ts](src/mcp/builtins.ts#L433-L640), [src/mcp/builtins.ts](src/mcp/builtins.ts#L866-L887), [src/mcp/fsGuard.test.ts](src/mcp/fsGuard.test.ts#L1-L58), [package.json](package.json#L27-L52)

## Findings

### 1. The `runShellCommand` async plan can race the close handler

The plan correctly identifies that `safeFileSize`, `readFileTail`, and `checkOutputGrowth` must become async, but the proposed interval rewrite is not safe as written. The current code's sync `checkOutputGrowth` runs entirely before the event loop can process `child.on("close")`; after the migration in [SPEC/v2/review-2026-05-round2/G30/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G30/03-plan-r1.md#L59-L88), a stat operation can remain in flight while the close handler starts at [src/mcp/builtins.ts](src/mcp/builtins.ts#L523-L541). That in-flight tick can later call `terminate("inactivity")`, mutate `timeoutKind`, and schedule a kill timer after the child has already exited, or even before the close handler reaches the final timeout checks. The result can be a normally completed command reported as an inactivity timeout.

The same section needs one more control-flow correction: [SPEC/v2/review-2026-05-round2/G30/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G30/03-plan-r1.md#L40-L45) says the new `await mkdir(...)` calls happen inside `runShellCommand` before the `new Promise` body returns. The actual function currently returns `new Promise(...)` immediately at [src/mcp/builtins.ts](src/mcp/builtins.ts#L433-L440). The plan must explicitly move both `await mkdir(...)` calls before constructing the `Promise`; using an async Promise executor would leave mkdir failures unhandled and the returned promise potentially unsettled.

Required change: revise the plan/design to include a `settled` or `closed` flag that is set before/at `child.on("close")`, checked after every awaited stat before touching `timeoutKind`, `lastOutputBytes`, or `lastGrowthAt`, and clears any post-close kill scheduling. Also spell out the pre-`Promise` mkdir placement. Add a focused shell test for a fast normal exit with inactivity polling enabled, ideally with a delayed stat/tail path or a fakeable helper so the race is covered deterministically.

### 2. The proposed no-sync-fs guard is not dependency-clean or reusable yet

The guard is the right architectural pressure valve, but the concrete test in [SPEC/v2/review-2026-05-round2/G30/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G30/03-plan-r1.md#L131-L167) imports `tinyglobby` while [package.json](package.json#L27-L52) does not declare it. It only appears transitively in [package-lock.json](package-lock.json#L9566-L9707), so importing it from a project test is brittle and can fail under dependency pruning or future lockfile churn. That also undermines the stated goal that G06/G36/G37 can reuse the guard unchanged.

The regex check is also too narrow for a reusable guard: it handles one named-import block from `node:fs`, but would miss namespace/default imports and can produce false results if future source comments mention `readFileSync` while no actual import exists. For G30's immediate file this may pass, but it is not the reusable regression guard the design claims in [SPEC/v2/review-2026-05-round2/G30/02-design-r1.md](SPEC/v2/review-2026-05-round2/G30/02-design-r1.md#L191-L199).

Required change: make the guard dependency-free with `fs/promises.readdir` recursion or add an explicit dev dependency, with dependency-free preferred. Factor the scanner as a tiny local helper that accepts roots and allow-lists, checks all `node:fs` import forms, excludes `*.test.ts`, and can be reused by G06/G36/G37 without copy-pasted hard-coded `src/mcp` assumptions.

### 3. The workspace-wide guard coordination is factually incomplete

The sequencing section says that after G30/G06/G36/G37 land, the final batch can consolidate the per-module guards into one workspace-wide guard with an allow-list for only the `recovery.ts` lockfile primitives, while noting just [src/repo-layout/contract.ts](src/repo-layout/contract.ts#L29-L154) and [src/knowledge/builtinWalker.ts](src/knowledge/builtinWalker.ts#L13-L139) as remaining out-of-scope imports in [SPEC/v2/review-2026-05-round2/G30/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G30/03-plan-r1.md#L269-L279). The current source has more non-test `node:fs` users: [src/agents/prompts.ts](src/agents/prompts.ts#L9-L51), [src/agents/base.ts](src/agents/base.ts#L7), [src/server/cli.ts](src/server/cli.ts#L493-L538), [src/server/bootstrap.ts](src/server/bootstrap.ts#L15-L720), [src/knowledge/store.ts](src/knowledge/store.ts#L14-L286), plus the sibling findings [src/runtime/stash.ts](src/runtime/stash.ts#L6-L67), [src/auth/store.ts](src/auth/store.ts#L8-L66), and [src/config.ts](src/config.ts#L2-L280).

This does not block G30 from shipping a `src/mcp` guard, but it does block the current cross-finding plan from being a reliable metaplan. If an implementer follows it literally, the final workspace-wide guard either fails immediately or grows an ad hoc allow-list that was never reviewed.

Required change: replace the final workspace-wide-guard claim with an explicit audit table: sibling fixes covered by G06/G36/G37, deliberately sync exceptions inherited from F22, and still-unowned sync-fs sites that need separate findings or explicit allow-list rationale before a root `src/no-sync-fs.test.ts` lands.

## Non-blocking review notes

- The analysis count is correct. The current [src/mcp/builtins.ts](src/mcp/builtins.ts#L15-L26) has eight blocking sync imports plus unused `existsSync`, and the writer's 16 executable call sites match [src/mcp/builtins.ts](src/mcp/builtins.ts#L226-L304), [src/mcp/builtins.ts](src/mcp/builtins.ts#L443-L628), and [src/mcp/builtins.ts](src/mcp/builtins.ts#L869-L887).
- Proposal A is the right recommendation over Proposal B. F22's approved direction was an in-place async conversion with targeted local mechanics, not a new filesystem abstraction layer, and reviving deleted `fsGuard.ts` would reverse the round-2 subsystem map without enough payoff. The current [src/mcp/fsGuard.test.ts](src/mcp/fsGuard.test.ts#L1-L58) remains valid because it tests the public `write_file` guard through `registerBuiltinServices`, not a deleted module import.
- The no-backward-compat posture is mostly clean: drop the sync imports outright, drop dead `existsSync`, keep public MCP tool names/result shapes stable, and do not add parallel sync helpers.
- Daemon coverage is adequate for this v2 finding: the plan covers `saivage` at 10.0.3.111, `saivage-v3` at 10.0.3.112, and `diedrico` at 10.0.3.113 in [SPEC/v2/review-2026-05-round2/G30/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G30/03-plan-r1.md#L179-L188), and correctly excludes the v3 GetRich container.

## Required change count

3

VERDICT: CHANGES_REQUESTED