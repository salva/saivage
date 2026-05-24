# F12 — Design r1

Two proposals. Proposal A is the focused fix that breaks the cross-file literal duplication without rethinking the layer. Proposal B is one conceptual level up: collapse the three-layer ordering (outer race / inner cap / agent-suggested) into a single computed bound and let the prompts pull their recommended values from runtime metadata so prose cannot drift.

A third option ("delete the outer race entirely") was considered and rejected; the outer race is the only defence against a misbehaving in-process handler hanging without ever invoking `runShellCommand`'s own kill timer, so removing it would lose a real safety property. It is not listed as a proposal because it is not viable.

## Proposal A — Derive `MAX_WALL_CLOCK_MS` from `config.mcp.shellTimeoutMs` (focused fix)

**Scope (files touched):**

- [src/config.ts](src/config.ts#L70-L78) — adds the `mcp` block (`shellTimeoutMs`, `inProcessTimeoutMs`, `shellTimeoutFloorMs`, `maxOutputBytes`, `maxFetchChars`, `maxDownloadBytes`) per the F11 r2 design. F12 only consumes `shellTimeoutMs` and `shellTimeoutFloorMs`; the others land via F11.
- [src/mcp/runtime.ts](src/mcp/runtime.ts#L165-L171) — `SHELL_TIMEOUT_MS` is no longer a `private static readonly` literal; it becomes a `private readonly` instance field initialised from the `SaivageConfig.mcp.shellTimeoutMs` value passed to the constructor. Expose it via a `get shellTimeoutMs(): number` accessor so `builtins.ts` can read it.
- [src/mcp/builtins.ts](src/mcp/builtins.ts#L36-L42) — delete the `MAX_WALL_CLOCK_MS = 4 * 60 * 60 * 1000 - 30_000` constant. `registerBuiltinServices(runtime, …)` (already takes `runtime`) reads `runtime.shellTimeoutMs` and derives the wall-clock cap as `runtime.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS`, where `WALL_CLOCK_HEADROOM_MS = 30_000` lives at module scope in `builtins.ts` with a comment naming the invariant (`inner cap must finish before the outer race fires`). At call-time inside `shellHandler` ([src/mcp/builtins.ts](src/mcp/builtins.ts#L375-L394)), apply `effectiveTimeout = Math.min(timeout ?? Infinity, runtime.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS)`. This is the new line that enforces invariant (1) regardless of what the agent supplies.
- Worker prose at [src/agents/coder.ts](src/agents/coder.ts#L64), [src/agents/manager.ts](src/agents/manager.ts#L140), [src/agents/researcher.ts](src/agents/researcher.ts#L62), [src/agents/data-agent.ts](src/agents/data-agent.ts#L55), [src/agents/reviewer.ts](src/agents/reviewer.ts#L45), [src/agents/inspector.ts](src/agents/inspector.ts#L74) — no change in r1. The values `600000 / 1800000 / 3600000` happen to be well below the new derived cap; the prompts already describe them as "recommended", not as absolutes, so they remain valid prose. (See Proposal B for the level-up that addresses this.)
- [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L43-L59) — already sets `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS=0`; F11 r2 replaces that env var with `config.mcp.shellTimeoutFloorMs`. F12 adds one new test asserting `effectiveTimeout` for a `timeout_ms: 9 * 60 * 60 * 1000` request gets clamped to `shellTimeoutMs - 30_000` (proving invariant 1).

**What gets added:** `WALL_CLOCK_HEADROOM_MS` const, `McpRuntime.shellTimeoutMs` accessor, one `Math.min` line in `shellHandler`, one new test.

**What gets removed:** `MAX_WALL_CLOCK_MS` constant (the offending duplicated literal), the implicit invariant that an oversized `timeout_ms` works by coincidence, and the comment at [src/mcp/builtins.ts](src/mcp/builtins.ts#L36-L38) that names `McpRuntime.SHELL_TIMEOUT_MS` without an import (the import becomes real).

**Risk:** Low. One numeric path changes — the upper clamp on agent-supplied `timeout_ms`. A worker that requested e.g. `10 * 60 * 60 * 1000` previously got the outer-race error; now it gets a structured timeout at `3h59m30s`. That is a strict improvement.

**What it enables:**
- F11 (constants → config) has one less ambiguous home for the shell-timeout envelope.
- F20 (per-model context) and F11 share the `config.mcp` block introduced by F11; F12 does not add a second config home.
- F33 (config defaults drift) sees only the keys F11 already adds.

**What it forbids:** Re-introducing a parallel hardcoded shell-timeout literal anywhere. Any future change to the envelope is a one-line edit in `config.ts` defaults.

**Cross-link:** F11 owns the `config.mcp.shellTimeoutMs` introduction; F12 owns the derivation and the agent-supplied clamp. F11 r2 design explicitly defers the derivation to F12 ([SPEC/v2/review-2026-05/F11/02-design-r2.md](../F11/02-design-r2.md), Proposal B "MAX_WALL_CLOCK_MS keeps deriving from shell timeout but the derivation moves to F12's territory").

**Recommendation note:** Recommended. Fixes the exact ticket without dragging in the prompt-prose problem (which is real but a separate hazard with its own constraints — workers cannot easily template-substitute mid-sentence numbers without a prompt-rendering pass that does not exist today).

## Proposal B — Single shell-timeout policy object + computed prompt values (level-up)

**Scope (files touched):**

- Everything in Proposal A, plus:
- [src/config.ts](src/config.ts) — `config.mcp` adds `shellTimeoutHeadroomMs` (default `30_000`) and `shellRecommendedTimeouts` (default `{ quick: 600_000, build: 1_800_000, heavy: 3_600_000 }`). The three-named-value object is the single source of truth for "values the agent is told to use".
- New module [src/mcp/shellTimeout.ts](src/mcp/shellTimeout.ts) (new file) — exports `class ShellTimeoutPolicy` with:
  - `readonly outerEnvelopeMs` (== `config.mcp.shellTimeoutMs`).
  - `readonly innerCapMs` (== `shellTimeoutMs - headroomMs`).
  - `readonly floorMs` (== `config.mcp.shellTimeoutFloorMs`).
  - `readonly recommended` (the `{quick, build, heavy}` object).
  - `clampSuggested(ms: number | undefined): number` — applies floor and inner-cap in one call.
  - `formatPromptSnippet(roleHint: "quick" | "build" | "heavy" | "all"): string` — returns the canned LLM-facing sentence ("The system enforces a 10-minute minimum; values below 600000 are raised…"), with the numbers interpolated from `recommended` and `floorMs`.
- [src/mcp/runtime.ts](src/mcp/runtime.ts) — constructor receives `ShellTimeoutPolicy` (alongside the rest of `SaivageConfig`); `outerEnvelopeMs` is what gets passed to `withTimeout` at [src/mcp/runtime.ts](src/mcp/runtime.ts#L187-L191).
- [src/mcp/builtins.ts](src/mcp/builtins.ts) — `registerBuiltinServices(runtime, policy, …)`; `shellHandler` calls `policy.clampSuggested(timeout)` instead of the local `clampTimeout` / `MAX_WALL_CLOCK_MS` arithmetic. `parseOptionalTimeoutMs` still runs, but `clampTimeout`/`shellTimeoutFloorMs`/`MAX_WALL_CLOCK_MS` go away — replaced by the policy.
- Six worker prompts at [src/agents/coder.ts](src/agents/coder.ts#L64), [src/agents/manager.ts](src/agents/manager.ts#L140), [src/agents/researcher.ts](src/agents/researcher.ts#L62), [src/agents/data-agent.ts](src/agents/data-agent.ts#L55), [src/agents/reviewer.ts](src/agents/reviewer.ts#L45), [src/agents/inspector.ts](src/agents/inspector.ts#L74) — each role's system-prompt template stops inlining `600000 / 1800000 / 3600000` and instead inlines `${policy.formatPromptSnippet(roleHint)}` at construction time. The prompt-construction site for each agent already runs in TypeScript (the system prompts are string literals with no current templating); we add a small one-line interpolation. The `roleHint` per file: coder/researcher → `"all"`, manager → `"all"`, data-agent → `"heavy"` (its existing recommendations are 1800000/3600000 only), reviewer/inspector → `"build"` (their existing recommendations are 600000/1800000 only).
- [src/server/bootstrap.ts](src/server/bootstrap.ts) — instantiates `ShellTimeoutPolicy` from loaded `SaivageConfig` once, passes it to `McpRuntime`, `registerBuiltinServices`, and the agent factory so prompt rendering uses the same instance.
- [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts) — same delta as Proposal A plus a test that asserts `formatPromptSnippet("all")` contains the recommended values from a custom-config policy (proves the prompt cannot diverge from the runtime cap).

**What gets added:** ~120 LoC: `ShellTimeoutPolicy`, two config keys, six call-site changes in the agent files, three new tests.

**What gets removed:** `MAX_WALL_CLOCK_MS`, `DEFAULT_MIN_TIMEOUT_MS`, `clampTimeout`, `shellTimeoutFloorMs`, the `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS` env-var handling (already deleted in F11 r2 Proposal B), and the hand-typed `600000 / 1800000 / 3600000` strings across six agent files. The "Recommended: …" prose stays, but the numbers come from one source.

**Risk:** Medium. Prompt-text changes are LLM-behaviour-affecting; the wording barely changes (numbers identical by default) but any prompt edit warrants spot-check. New `ShellTimeoutPolicy` class is a real abstraction — justified because it has three distinct consumers (`McpRuntime`, `builtins.shellHandler`, six agent prompts), not one. Slight wiring overhead in `bootstrap.ts`.

**What it enables:**
- Operators can lengthen `shellTimeoutMs` to e.g. 8h and the workers' prompts will instruct them to ask for proportionally longer commands without any code edit.
- F11 (constants → config) sees the prompt-derived values as one more reason `config.mcp` is the right home.
- F28 (registry unused — [src/mcp/registry.ts](src/mcp/registry.ts) persistence is vestigial) is touched lightly: `ShellTimeoutPolicy` lives in `mcp/` alongside the registry but does not extend it. No coupling.
- F34 (plan-server no caching — [src/mcp/plan-server.ts](src/mcp/plan-server.ts) re-reads disk per call) is unrelated; the `ShellTimeoutPolicy` lives in the same subsystem but the two changes do not touch shared files. F12 and F34 can land in either order.

**What it forbids:**
- Inlining timeout numerics in any new agent prompt without going through `policy.formatPromptSnippet`.
- Adding a fourth "recommended" tier (e.g. `extra-heavy`) without extending `recommended` — closes the failure mode where a new role's prompt invents its own number.
- Any future caller adding a second wall-clock cap that does not derive from `policy.innerCapMs`.

**Cross-link:** Sits cleanly on top of F11 r2 Proposal B (which introduces `config.mcp.shellTimeoutMs`). F12 Proposal B subsumes the small `clampSuggested` logic that Proposal A bolts onto `shellHandler`.

**Recommendation note:** Runner-up. The prompt-prose problem is real but localised (six files, identical paragraph); collapsing it through a templated policy is a genuine level-up. It is not the *focused* fix the ticket asks for, and the project guideline against premature abstraction makes a 120-LoC policy class a non-trivial bar to clear when the immediate damage (silent outer-race firing) is removed by Proposal A's one-line `Math.min`.

## Recommendation

**Proposal A.** It does the exact thing the ticket asks for — eliminate the cross-file coupling — with the smallest viable footprint, deletes a literal rather than adding an abstraction, and composes cleanly with F11 r2's `config.mcp.shellTimeoutMs`. The prompt-prose duplication is a known weakness; if a future operator changes `shellTimeoutMs` to a value that invalidates the worker prompts' recommended numbers (e.g. drops it below 1h), revisit Proposal B then. Today the recommended numbers are LLM hints, not enforced contracts, and the new `clampSuggested` guarantees the invariant regardless of what the LLM picks.
