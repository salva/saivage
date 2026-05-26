# F12 — Design r2

## Changes from r1

- **Proposal A — Scope narrowed and hardened.** No longer claims to address worker-prompt drift; the analysis r2 drops that constraint. Adds an explicit **schema-level validation** (Zod cross-field refine) of the timing envelope so impossible configurations are rejected at load time, not papered over with runtime guards. Pins the `McpRuntime` constructor signature to one concrete shape — `new McpRuntime(config: SaivageConfig, options?: McpRuntimeOptions)` — and lists the exact `registerBuiltinServices` signature change. If F11 lands with a `config.mcp` slice instead of full `SaivageConfig`, F12's Step 1 widens it (one-line edit) before any other F12 step runs; the plan calls this out.
- **Proposal B — kept for future reference, still not recommended.** No content change; it remains the level-up captured for the day someone files a "I changed `shellTimeoutMs` and now the worker prompts lie" ticket. Out of scope for F12 r2 per the narrowed analysis.
- Recommendation unchanged: Proposal A.

Two proposals. Proposal A is the focused fix that breaks the cross-file literal duplication, applies a hard upper clamp on caller-supplied `timeout_ms`, and validates the timing envelope at the schema boundary. Proposal B is one conceptual level up: collapse the three-layer ordering into a single computed policy and let prompts pull recommended values from runtime metadata so prose cannot drift.

A third option ("delete the outer race entirely") was considered and rejected; the outer race is the only defence against a misbehaving in-process handler hanging without ever invoking `runShellCommand`'s own kill timer, so removing it would lose a real safety property.

## Proposal A — Derive `MAX_WALL_CLOCK_MS` from `config.mcp.shellTimeoutMs` + schema-level envelope validation (RECOMMENDED)

**Scope (files touched):**

- [src/config.ts](src/config.ts#L68-L78) — F11 r2 adds the `mcp` block (`shellTimeoutMs`, `shellTimeoutFloorMs`, `inProcessTimeoutMs`, `maxOutputBytes`, `maxFetchChars`, `maxDownloadBytes`). **F12 adds a `.superRefine` to the `mcp` block** that enforces, with `WALL_CLOCK_HEADROOM_MS = 30_000` imported from [src/mcp/builtins.ts](src/mcp/builtins.ts):
  - `mcp.shellTimeoutMs > WALL_CLOCK_HEADROOM_MS` (inner cap is positive).
  - `mcp.shellTimeoutFloorMs <= mcp.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS` (floor cannot raise a clamped value past the inner cap).
  Both violations raise a `ZodIssue` with a path of `["mcp", "shellTimeoutMs"]` or `["mcp", "shellTimeoutFloorMs"]` and a message naming the headroom, e.g. `"mcp.shellTimeoutMs must exceed WALL_CLOCK_HEADROOM_MS (30000ms); got 25000"`. `loadConfig` already throws on `parse` failure (boundary validation), so impossible envelopes are rejected before any runtime sees them.
- [src/mcp/runtime.ts](src/mcp/runtime.ts#L67) — **constructor pinned to `constructor(config: SaivageConfig, options: McpRuntimeOptions = {})`.** F11 r2 step 6.1 lists "accept a `SaivageConfig` (or `config.mcp` slice)"; F12 picks the full-config path because (a) it removes the existing `config.runtime`-vs-`config.mcp` split (today the constructor takes `SaivageConfig["runtime"]`), (b) `McpRuntime` already reads `idleShutdownMs` and `healthCheckIntervalMs` from `config.runtime`, so it already needs both slices, and (c) one parameter is simpler than two slices.
  - Replace `private static readonly IN_PROCESS_TIMEOUT_MS = 300_000` and `private static readonly SHELL_TIMEOUT_MS = 4 * 60 * 60 * 1000` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L168-L172)) with `private readonly inProcessTimeoutMs: number` and `private readonly shellTimeoutMs: number`, initialised from `config.mcp.inProcessTimeoutMs` and `config.mcp.shellTimeoutMs`.
  - Update the two reads at [src/mcp/runtime.ts](src/mcp/runtime.ts#L184-L186) to use the instance fields.
  - Expose `public get shellTimeoutMs(): number { return this.shellTimeoutMs; }` (or use TS `readonly` field directly — `runtime.shellTimeoutMs` is the read access that `builtins.ts` needs).
- [src/mcp/builtins.ts](src/mcp/builtins.ts#L36-L42) — delete `MAX_WALL_CLOCK_MS` and `DEFAULT_MIN_TIMEOUT_MS` (the latter goes away because F11 r2 already replaces the env-var with `config.mcp.shellTimeoutFloorMs`; the `10 * 60 * 1000` literal is no longer needed). **Export** at module scope:
  ```ts
  export const WALL_CLOCK_HEADROOM_MS = 30_000;
  ```
  (exported so the `configSchema.superRefine` in `src/config.ts` can import it; this keeps the headroom value as a single source of truth shared by schema validation and the runtime arithmetic.)
- [src/mcp/builtins.ts](src/mcp/builtins.ts#L382-L392) — inside the existing `shellHandler` closure (where `runtime` is already in scope through `registerBuiltinServices(runtime, ...)`), replace
  ```ts
  const effectiveTimeout = timeout ?? MAX_WALL_CLOCK_MS;
  ```
  with
  ```ts
  const innerCapMs = runtime.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS;
  const effectiveTimeout = Math.min(timeout ?? innerCapMs, innerCapMs);
  ```
  The schema refine guarantees `innerCapMs > 0`, so the arithmetic is safe without runtime guards. `clampTimeout` still runs *before* this (on raw `timeout_ms`) so a caller-supplied value first gets raised to the floor (if any), then ceiling-clamped to `innerCapMs`. The schema refine also guarantees `floor <= innerCapMs`, so the two clamps cannot disagree.
- [src/mcp/builtins.ts](src/mcp/builtins.ts) `registerBuiltinServices` — F11 r2 step 6.3 changes the signature to take `config.mcp` (or full `SaivageConfig`). F12 pins this to **`registerBuiltinServices(runtime: McpRuntime, options: BuiltinServicesOptions = {})`** unchanged — `runtime.shellTimeoutMs` is the access used by the derivation, so no new positional argument is needed; `config.mcp.maxOutputBytes` etc. are already plumbed through `runtime` after F11 (or via a small `runtime.mcp` accessor; F11 r2 leaves the exact plumbing flexible). The F12-specific code path only needs `runtime.shellTimeoutMs`.
- [src/server/bootstrap.ts](src/server/bootstrap.ts#L140) — change `new McpRuntime(config.runtime)` to `new McpRuntime(config)`. One-line edit.
- Worker prose at [src/agents/coder.ts](src/agents/coder.ts#L64) and friends — **no change** in F12. The `600000 / 1800000 / 3600000` strings remain LLM hints; the new `Math.min` clamp protects the invariant regardless of what the LLM picks. (Worker-prompt sourcing is Proposal B's territory.)
- [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts) — F11 r2 step 8.1 already replaces the `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS=0` env mutation with a `config.mcp.shellTimeoutFloorMs: 0` field on the constructed config. F12 changes the test setup to construct a `SaivageConfig` (full, via the existing `loadConfig({ ... })` helper or an inline object literal that satisfies the schema), and adds two new tests:
  1. `"clamps caller-supplied timeout_ms above the derived inner cap"` — use `shellTimeoutMs: 30_050` and `shellTimeoutFloorMs: 0`, giving `innerCapMs = 50`. Invoke `run_command` with `timeout_ms: 9 * 60 * 60 * 1000` against `node -e "setTimeout(() => {}, 60000)"`. Assert `exitCode === 124` and `stderr` contains `"Command timed out after 50ms"`. Test wall-clock budget: ~50 ms.
  2. `"applies the derived inner cap when timeout_ms is omitted"` — same setup, no `timeout_ms`. Same assertions. Test wall-clock budget: ~50 ms.
- [src/config.test.ts](src/config.test.ts) — three new assertions:
  1. `loadConfig({ mcp: { shellTimeoutMs: 25_000 } })` throws a `ZodError` whose message names `WALL_CLOCK_HEADROOM_MS`.
  2. `loadConfig({ mcp: { shellTimeoutMs: 1_200_000, shellTimeoutFloorMs: 1_200_000 } })` throws (floor exceeds derived cap by exactly 30_000 ms).
  3. `loadConfig({ mcp: { shellTimeoutMs: 1_200_000, shellTimeoutFloorMs: 1_170_000 } })` succeeds (`shellTimeoutFloorMs === shellTimeoutMs - WALL_CLOCK_HEADROOM_MS` is the boundary — allowed).

**What gets added:**

- `WALL_CLOCK_HEADROOM_MS = 30_000` exported from `builtins.ts` (replaces the implicit `30_000` literal previously embedded in `MAX_WALL_CLOCK_MS`).
- One `.superRefine` block on `configSchema.mcp` in `src/config.ts` enforcing Invariants 2 and 3 from the analysis.
- One `Math.min` line in `shellHandler` enforcing Invariant 1.
- Two fast structured-message timeout tests; three schema validation tests.

**What gets removed:**

- `MAX_WALL_CLOCK_MS` (the duplicated literal).
- `DEFAULT_MIN_TIMEOUT_MS` (already-deletion path via F11 r2 step 6.4; F12 confirms it stays gone).
- The implicit "an oversized caller-supplied `timeout_ms` works by coincidence" invariant.
- The runtime-side need to defend against zero/negative inner caps (the schema rejects them).

**Risk:** Low. Two numeric paths change: (a) the upper clamp on agent-supplied `timeout_ms` (a worker that requested e.g. `10 * 60 * 60 * 1000` previously got the unstructured outer-race error; now it gets the structured `Command timed out after 14370000ms` — strict improvement); (b) impossible config envelopes that previously would have caused runtime errors now fail config load with a clear Zod message. No runtime regression for valid configs.

**What it enables:**

- F11 has one less ambiguous home for the shell-timeout envelope.
- F20 (per-model context) and F11 share the `config.mcp` block introduced by F11; F12 does not add a second config home.
- F33 (config defaults drift) sees only the keys F11 already adds plus a single refine — no new keys.

**What it forbids:**

- Re-introducing a parallel hardcoded shell-timeout literal anywhere.
- Adding a new caller-supplied timeout path that bypasses the `Math.min` clamp.
- Shipping a config whose `shellTimeoutMs <= WALL_CLOCK_HEADROOM_MS` or whose floor exceeds the derived cap.

**Cross-link:** F11 owns the `config.mcp.shellTimeoutMs` introduction; F12 owns the derivation, the agent-supplied clamp, and the envelope validation. F11 r2 design defers the derivation to F12 ([SPEC/v2/review-2026-05/F11/02-design-r2.md](../F11/02-design-r2.md#L37-L38) "`MAX_WALL_CLOCK_MS` keeps deriving from shell timeout but the derivation moves to F12's territory"); F11 r2 plan step 6.5 explicitly says "F12 will replace this with the proper invariant" ([SPEC/v2/review-2026-05/F11/03-plan-r2.md](../F11/03-plan-r2.md#L101-L107)).

**Recommendation note:** Recommended. Fixes the exact ticket within its narrowed scope, hardens the schema boundary, and produces fast deterministic tests.

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

**Proposal A.** It does the exact thing the narrowed ticket asks for — eliminate the cross-file coupling and the no-upper-bound caller path — with the smallest viable footprint, deletes literals rather than adding an abstraction, hardens the config boundary so impossible envelopes never reach runtime, and composes cleanly with F11 r2's `config.mcp.shellTimeoutMs`. The prompt-prose duplication is a known but separate weakness; if a future operator changes `shellTimeoutMs` in a way that invalidates the worker prompts' recommended numbers, revisit Proposal B then. Today the recommended numbers are LLM hints, not enforced contracts, and the new `Math.min` guarantees the invariant regardless of what the LLM picks.
