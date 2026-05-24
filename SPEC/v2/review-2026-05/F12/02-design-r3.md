# F12 — Design r3

## Changes from r2

- **Reconciled with F11's approved `registerBuiltinServices` shape.** F11 r2 step 6.3 ([../F11/03-plan-r2.md](../F11/03-plan-r2.md#L93-L100)) is explicit: the builtins factory signature changes to take `config.mcp`, so `MAX_OUTPUT`, `MAX_FETCH_CHARS`, `MAX_DOWNLOAD_BYTES` become closure-captured locals. r2 contradicted that by pinning `registerBuiltinServices(runtime, options)` as unchanged. r3 aligns: the signature after F11 + F12 is **`registerBuiltinServices(runtime: McpRuntime, mcpConfig: SaivageConfig["mcp"], options: BuiltinServicesOptions = {})`**, and F12's `shellHandler` closure derives `innerCapMs` from `mcpConfig.shellTimeoutMs` (the same closure-captured arg F11 uses for the size caps), not from a public `McpRuntime` field. This removes the duplicate "where does shellTimeoutMs live" question.
- **Dropped the proposed `public readonly McpRuntime.shellTimeoutMs` exposure.** F11 stores it as a private instance field on `McpRuntime` and consumes it only at the dispatch site ([src/mcp/runtime.ts](src/mcp/runtime.ts#L184-L186)); F12 no longer needs to read it from outside. Both files derive their numbers from the same `config.mcp` block, so there is no second access path to keep in sync.
- **Removed the recursive getter example.** r2 listed `public get shellTimeoutMs(): number { return this.shellTimeoutMs; }` as an option; that body recurses. r3 deletes the option entirely (see the previous bullet) so no implementer can copy a broken accessor.
- **Pinned `McpRuntime` constructor to the full-`SaivageConfig` shape** (unchanged from r2 — preserved here so the design captures the F11 ambiguity resolution alongside the builtins-factory one). Bootstrap site at [src/server/bootstrap.ts](src/server/bootstrap.ts#L140) becomes `new McpRuntime(config)`.

Two proposals (carried from r2). Proposal A is the focused fix: break the cross-file literal duplication, hard-clamp caller-supplied `timeout_ms`, and reject impossible timing envelopes at the schema boundary. Proposal B is one conceptual level up: a single shell-timeout policy object that also drives worker-prompt prose; kept for future reference, not recommended.

A third option ("delete the outer race entirely") was considered and rejected; the outer race is the only defence against a misbehaving in-process handler hanging without ever invoking `runShellCommand`'s own kill timer.

## Proposal A — Derive inner cap from `mcpConfig.shellTimeoutMs` + schema-level envelope validation (RECOMMENDED)

**Scope (files touched):**

- [src/config.ts](src/config.ts#L68-L78) — F11 r2 adds the `mcp` block (`shellTimeoutMs`, `shellTimeoutFloorMs`, `inProcessTimeoutMs`, `maxOutputBytes`, `maxFetchChars`, `maxDownloadBytes`). **F12 adds a `.superRefine` on the `mcp` block** that imports `WALL_CLOCK_HEADROOM_MS` from [src/mcp/builtins.ts](src/mcp/builtins.ts) and enforces:
  - `mcp.shellTimeoutMs > WALL_CLOCK_HEADROOM_MS` (inner cap is positive).
  - `mcp.shellTimeoutFloorMs <= mcp.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS` (floor cannot raise a clamped value past the inner cap).

  Both violations raise a `ZodIssue` with `path: ["shellTimeoutMs"]` or `["shellTimeoutFloorMs"]` and a message naming the headroom (e.g. `"mcp.shellTimeoutMs must exceed WALL_CLOCK_HEADROOM_MS (30000ms); got 25000"`). `loadConfig` already throws on parse failure, so impossible envelopes are rejected before any runtime sees them.

- [src/mcp/runtime.ts](src/mcp/runtime.ts#L67) — constructor pinned to **`constructor(config: SaivageConfig, options: McpRuntimeOptions = {})`**. F11 r2 step 6.1 lists "accept a `SaivageConfig` (or `config.mcp` slice)"; F12 picks the full-config path because (a) `McpRuntime` already reads `idleShutdownMs` and `healthCheckIntervalMs` from `config.runtime`, so it already needs both slices, and (b) one parameter is simpler than two slices.
  - Replace `private static readonly IN_PROCESS_TIMEOUT_MS = 300_000` and `private static readonly SHELL_TIMEOUT_MS = 4 * 60 * 60 * 1000` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L168-L172)) with `private readonly inProcessTimeoutMs: number` and `private readonly shellTimeoutMs: number`, initialised from `config.mcp.inProcessTimeoutMs` and `config.mcp.shellTimeoutMs`.
  - Update the dispatch site at [src/mcp/runtime.ts](src/mcp/runtime.ts#L184-L186) to use the instance fields.
  - `shellTimeoutMs` stays **private**. No public accessor, no getter. F12's clamp does not read it from runtime; F12 reads `mcpConfig.shellTimeoutMs` directly from its own closure-captured factory argument (next bullet).

- [src/mcp/builtins.ts](src/mcp/builtins.ts#L36-L42) — delete `MAX_WALL_CLOCK_MS` and `DEFAULT_MIN_TIMEOUT_MS` (the latter goes away via F11 r2 step 6.4). **Export** at module scope:
  ```ts
  export const WALL_CLOCK_HEADROOM_MS = 30_000;
  ```
  Exported so the `configSchema.superRefine` in [src/config.ts](src/config.ts) can import it — single source of truth shared by schema validation and the runtime arithmetic.

- [src/mcp/builtins.ts](src/mcp/builtins.ts) `registerBuiltinServices` — **aligned with F11**. After F11 + F12 the signature is:
  ```ts
  export function registerBuiltinServices(
    runtime: McpRuntime,
    mcpConfig: SaivageConfig["mcp"],
    options: BuiltinServicesOptions = {},
  ): void
  ```
  F11 r2 step 6.3 already introduces the `mcpConfig` parameter to closure-capture `MAX_OUTPUT`, `MAX_FETCH_CHARS`, `MAX_DOWNLOAD_BYTES`. F12 reuses the same parameter for the inner-cap derivation; no additional positional argument is introduced. The `runtime` parameter is still passed because the registration calls (`runtime.registerInProcess(...)`) need it.

- [src/mcp/builtins.ts](src/mcp/builtins.ts#L36-L42) and [src/mcp/builtins.ts](src/mcp/builtins.ts#L382-L392) — convert `shellHandler` from a module-scope `const` to a **factory-built closure** inside `registerBuiltinServices`. After F11, the size caps (`MAX_OUTPUT`, `MAX_FETCH_CHARS`, `MAX_DOWNLOAD_BYTES`) must already be closure-captured from `mcpConfig` (F11 step 6.3); the shell handler joins them. The derivation inside the closure becomes:
  ```ts
  const innerCapMs = mcpConfig.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS;
  const effectiveTimeout = Math.min(timeout ?? innerCapMs, innerCapMs);
  ```
  The schema refine guarantees `innerCapMs > 0`, so the arithmetic is safe without runtime guards. `clampTimeout` still runs *before* this (on raw `timeout_ms`) so a caller-supplied value first gets raised to the floor (if any), then ceiling-clamped to `innerCapMs`. The schema refine also guarantees `floor <= innerCapMs`, so the two clamps cannot disagree.

- [src/mcp/builtins.ts](src/mcp/builtins.ts) — replace the `effectiveTimeout = timeout ?? MAX_WALL_CLOCK_MS` line at [src/mcp/builtins.ts](src/mcp/builtins.ts#L392) with the two-line `Math.min` clamp above.

- [src/server/bootstrap.ts](src/server/bootstrap.ts#L140-L141) — two edits:
  1. `new McpRuntime(config.runtime)` → `new McpRuntime(config)`.
  2. `registerBuiltinServices(mcpRuntime, { promptInjectionCop })` → `registerBuiltinServices(mcpRuntime, config.mcp, { promptInjectionCop })`. (F11 r2 step 6 already updates this call to pass `config.mcp`; F12 confirms the signature alignment.)

- Worker prose at [src/agents/coder.ts](src/agents/coder.ts#L64) and friends — **no change** in F12. The `600000 / 1800000 / 3600000` strings remain LLM hints; the new `Math.min` clamp protects the invariant regardless of what the LLM picks. (Worker-prompt sourcing is Proposal B's territory.)

- [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts) — F11 r2 step 8.1 already replaces the `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS=0` env mutation with `config.mcp.shellTimeoutFloorMs: 0` on the constructed config and updates the `registerBuiltinServices` call to pass `config.mcp`. F12 changes the test setup to use a small `shellTimeoutMs` and adds two new tests:
  1. `"clamps caller-supplied timeout_ms above the derived inner cap"` — use `shellTimeoutMs: 30_050` and `shellTimeoutFloorMs: 0`, giving `innerCapMs = 50`. Invoke `run_command` with `timeout_ms: 9 * 60 * 60 * 1000` against `node -e "setTimeout(() => {}, 60000)"`. Assert `exitCode === 124` and `stderr` contains `"Command timed out after 50ms"`. Test wall-clock budget: ~50 ms.
  2. `"applies the derived inner cap when timeout_ms is omitted"` — same setup, no `timeout_ms`. Same assertions. Test wall-clock budget: ~50 ms.

- [src/config.test.ts](src/config.test.ts) — three new assertions:
  1. `loadConfig({ mcp: { shellTimeoutMs: 25_000 } })` throws a `ZodError` whose message names `WALL_CLOCK_HEADROOM_MS`.
  2. `loadConfig({ mcp: { shellTimeoutMs: 1_200_000, shellTimeoutFloorMs: 1_200_000 } })` throws (floor exceeds derived cap by exactly 30_000 ms).
  3. `loadConfig({ mcp: { shellTimeoutMs: 1_200_000, shellTimeoutFloorMs: 1_170_000 } })` succeeds (`shellTimeoutFloorMs === shellTimeoutMs - WALL_CLOCK_HEADROOM_MS` is the inclusive boundary — allowed).

**What gets added:**

- `WALL_CLOCK_HEADROOM_MS = 30_000` exported from `builtins.ts` (replaces the implicit `30_000` literal previously embedded in `MAX_WALL_CLOCK_MS`).
- One `.superRefine` block on `configSchema.mcp` in `src/config.ts` enforcing Invariants 2 and 3 from the analysis.
- One `Math.min` line inside the factory-built `shellHandler` enforcing Invariant 1.
- Two fast structured-message timeout tests; three schema validation tests.

**What gets removed:**

- `MAX_WALL_CLOCK_MS` (the duplicated literal).
- `DEFAULT_MIN_TIMEOUT_MS` (deleted by F11 r2 step 6.4; F12 confirms it stays gone).
- The implicit "an oversized caller-supplied `timeout_ms` works by coincidence" invariant.
- The runtime-side need to defend against zero/negative inner caps (the schema rejects them).
- Any thought of exposing `McpRuntime.shellTimeoutMs` publicly — F12 reads from the same `mcpConfig` parameter F11 already plumbs into `registerBuiltinServices`.

**Risk:** Low. Two numeric paths change: (a) the upper clamp on agent-supplied `timeout_ms` (a worker that requested e.g. `10 * 60 * 60 * 1000` previously got the unstructured outer-race error; now it gets the structured `Command timed out after Nms` — strict improvement); (b) impossible config envelopes that previously would have caused runtime errors now fail config load with a clear Zod message. No runtime regression for valid configs.

One implementation-shape risk worth naming: moving `shellHandler` from module scope into a factory closure inside `registerBuiltinServices` is a small refactor. F11 r2 step 6.3 already requires the same shape change for the size-cap handlers (`fetchHandler`, `downloadHandler`, etc.) that close over `MAX_OUTPUT` / `MAX_FETCH_CHARS` / `MAX_DOWNLOAD_BYTES`. F12 joins the shell handler to the same pattern; the cost is paid once.

**What it enables:**

- F11 has one less ambiguous home for the shell-timeout envelope.
- F20 (per-model context) and F11 share the `config.mcp` block introduced by F11; F12 does not add a second config home.
- F33 (config defaults drift) sees only the keys F11 already adds plus a single refine — no new keys.

**What it forbids:**

- Re-introducing a parallel hardcoded shell-timeout literal anywhere.
- Adding a new caller-supplied timeout path that bypasses the `Math.min` clamp.
- Shipping a config whose `shellTimeoutMs <= WALL_CLOCK_HEADROOM_MS` or whose floor exceeds the derived cap.
- Re-introducing a `McpRuntime.shellTimeoutMs` public accessor (the field stays private; consumers read `config.mcp.shellTimeoutMs`).

**Cross-link:** F11 owns the `config.mcp.shellTimeoutMs` introduction and the `registerBuiltinServices(..., config.mcp, ...)` signature change; F12 owns the inner-cap derivation, the agent-supplied clamp, and the schema-envelope validation. F11 r2 design defers the derivation to F12 ([SPEC/v2/review-2026-05/F11/02-design-r2.md](../F11/02-design-r2.md#L37-L42) "`MAX_WALL_CLOCK_MS` keeps deriving from shell timeout but the derivation moves to F12's territory"); F11 r2 plan step 6.5 explicitly says "F12 will replace this with the proper invariant" ([../F11/03-plan-r2.md](../F11/03-plan-r2.md#L101-L107)).

**Recommendation note:** Recommended. Fixes the exact ticket within its narrowed scope, hardens the schema boundary, produces fast deterministic tests, and shares the `mcpConfig` closure F11 already wires.

## Proposal B — Single shell-timeout policy object + computed prompt values (level-up, NOT RECOMMENDED for F12)

**Scope (files touched):**

- Everything in Proposal A, plus:
- [src/config.ts](src/config.ts) — `config.mcp` adds `shellTimeoutHeadroomMs` (default `30_000`) and `shellRecommendedTimeouts` (default `{ quick: 600_000, build: 1_800_000, heavy: 3_600_000 }`). The three-named-value object is the single source of truth for "values the agent is told to use".
- New module [src/mcp/shellTimeout.ts](src/mcp/shellTimeout.ts) (new file) — exports `class ShellTimeoutPolicy` with `outerEnvelopeMs`, `innerCapMs`, `floorMs`, `recommended`, `clampSuggested(ms): number`, `formatPromptSnippet(roleHint): string`.
- [src/mcp/runtime.ts](src/mcp/runtime.ts) — constructor receives a `ShellTimeoutPolicy` (alongside the rest of `SaivageConfig`); `outerEnvelopeMs` is what gets passed to `withTimeout`.
- [src/mcp/builtins.ts](src/mcp/builtins.ts) — `shellHandler` calls `policy.clampSuggested(timeout)` instead of local arithmetic.
- Six worker prompts at [src/agents/coder.ts](src/agents/coder.ts#L64), [src/agents/manager.ts](src/agents/manager.ts#L140), [src/agents/researcher.ts](src/agents/researcher.ts#L62), [src/agents/data-agent.ts](src/agents/data-agent.ts#L55), [src/agents/reviewer.ts](src/agents/reviewer.ts#L45), [src/agents/inspector.ts](src/agents/inspector.ts#L74) — each role's system-prompt template stops inlining `600000 / 1800000 / 3600000` and instead inlines `${policy.formatPromptSnippet(roleHint)}` at construction time.
- [src/server/bootstrap.ts](src/server/bootstrap.ts) — instantiates `ShellTimeoutPolicy` once from loaded config and passes it to `McpRuntime`, `registerBuiltinServices`, and the agent factory.
- [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts) — Proposal A's tests plus a test that asserts `formatPromptSnippet("all")` contains the recommended values from a custom-config policy.

**What gets added:** ~120 LoC: `ShellTimeoutPolicy`, two config keys, six agent-prompt call-site changes, three new tests.

**What gets removed:** Same as Proposal A plus the hand-typed `600000 / 1800000 / 3600000` strings across six agent files.

**Risk:** Medium. Prompt-text changes are LLM-behaviour-affecting (numbers identical by default, prose barely changes, but any prompt edit warrants spot-check). New `ShellTimeoutPolicy` class is a real abstraction — justified only if the worker-prompt drift is treated as F12's problem; the narrowed F12 analysis says it is not.

**What it enables:** Operators can lengthen `shellTimeoutMs` and the workers' prompts will instruct them to ask for proportionally longer commands without any code edit. Closes the prompt-drift failure mode permanently.

**What it forbids:** Inlining timeout numerics in any new agent prompt without going through `policy.formatPromptSnippet`. Adding a fourth "recommended" tier without extending `recommended`. Any future caller adding a second wall-clock cap that does not derive from `policy.innerCapMs`.

**Cross-link:** Sits cleanly on top of F11 r2 Proposal B. F12 Proposal B subsumes the small `Math.min` logic that Proposal A bolts onto `shellHandler`.

**Recommendation note:** Runner-up. The prompt-prose problem is real but localised (six files, identical paragraph); collapsing it through a templated policy is a genuine level-up. It is not the *focused* fix the narrowed ticket asks for, and the project guideline against premature abstraction makes a 120-LoC policy class a non-trivial bar to clear when the immediate damage (silent outer-race firing, impossible envelopes) is removed by Proposal A's one `Math.min` plus one `.superRefine`.

## Recommendation

**Proposal A.** It does the exact thing the narrowed ticket asks for — eliminate the cross-file coupling and the no-upper-bound caller path — with the smallest viable footprint, deletes literals rather than adding an abstraction, hardens the config boundary so impossible envelopes never reach runtime, and reuses the `mcpConfig` closure argument F11 already plumbs into `registerBuiltinServices`. The prompt-prose duplication is a known but separate weakness; if a future operator changes `shellTimeoutMs` in a way that invalidates the worker prompts' recommended numbers, revisit Proposal B then. Today the recommended numbers are LLM hints, not enforced contracts, and the new `Math.min` guarantees the invariant regardless of what the LLM picks.
