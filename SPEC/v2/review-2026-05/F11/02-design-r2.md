# F11 — Design r2

## Changes from r1

- **Proposal B no longer proposes to delete the `EventBus` constructor `handlerTimeoutMs` parameter.** r1 justified that deletion with "no caller overrides it", which is false — [src/events/bus.test.ts](src/events/bus.test.ts#L154-L167) constructs `new EventBus(10)` to keep its `resume()`-timeout test deterministic under fake timers. Treating that as configurability-for-no-reason was wrong: it is a test seam, in the same category as the `BaseAgent.transientCap` getter that r1 already protects. The parameter stays, and the analysis classifies `EventBus` accordingly.
- Updated Proposal A and Proposal C inventories to reflect the same reclassification (no EventBus parameter deletion).
- No change to the recommended proposal (still B), no change to anything else in the design.

Three proposals. A is the focused reading of the ticket (promote everything). B is one conceptual level up (inline + delete dead fallbacks; promote only what an operator actually tunes). C is a curated middle.

## Proposal A — Promote every listed constant to `SaivageConfig`

**Scope (files touched):**

- [src/config.ts](src/config.ts) — add nested blocks: `agent.loop` (nudges, invalidFinal, diagnosticBuffer, transientCap, llmBackoffBaseSeconds, llmBackoffMult, llmBackoffMaxSeconds), `runtime.dispatcher.maxConsecutiveInvalid`, `runtime.supervisor.forceCancelDelayMs` (new key alongside existing supervisor block), `runtime.recoveryDelayMs`, `runtime.notes.volatileTtlMs`, `runtime.shutdown.plannerTimeoutMs`, `mcp.inProcessTimeoutMs`, `mcp.shellTimeoutMs`, `mcp.shellTimeoutFloorMs`, `mcp.maxOutputBytes`, `mcp.maxFetchChars`, `mcp.maxDownloadBytes`, `mcp.processKillGraceMs`, `mcp.outputGrowthPollMs`, `providers.router.requestTimeoutMs`, `providers.router.primaryRetry{BaseDelayMs,Mult,MaxDelayMs}`, `providers.router.{initialBackoffMs,backoffMultiplier,maxBackoffMs}`, `events.handlerTimeoutMs`, `log.bufferLimit`, `chat.maxPendingMessages`, `web.poll.{title,plan,debug,status,agents,clock}Ms`, `web.ws.{initialBackoffMs,maxBackoffMs,backoffFactor}`.
- Every file in the F11 inventory: replace the inline `const` with a read from `SaivageConfig` (constructor injection or `loadConfig()` call).
- New SPA route or build-time injection to surface `web.*` block into the bundle.
- [src/server/cli.ts](src/server/cli.ts) `initProject` default writer kept in sync — see F33.

**Risk:** ~25 new config keys, each one a new default-drift opportunity (cf. F33), each one a real-world deployment knob nobody has any signal for setting. Test surface multiplies: each constructor now takes config; tests must thread it. SPA gets a new server contract just to read poll intervals.

**What it enables:** "any value an operator wants is config-set". Useful for one or two of them; theatre for the rest.

**What it forbids:** nothing new.

**Recommendation note:** rejected; violates "no premature configurability".

## Proposal B — Inline as named consts; delete dead fallbacks; promote only the small operator-facing set (LEVEL-UP, RECOMMENDED)

**Scope (files touched):**

- [src/config.ts](src/config.ts) — add exactly the following small additions:
  - `runtime.notes.volatileTtlMs` (default `2 * 60 * 60 * 1000`).
  - `runtime.recoveryDelayMs` (default `60_000`).
  - `runtime.supervisor.forceCancelDelayMs` (default `600_000`).
  - `mcp` block: `shellTimeoutMs` (default `4 * 60 * 60 * 1000`), `inProcessTimeoutMs` (default `300_000`), `maxOutputBytes` (default `102_400`), `maxFetchChars` (default `200_000`), `maxDownloadBytes` (default `262_144_000`), `shellTimeoutFloorMs` (default `600_000`, replaces the env-var `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS`).
- [src/runtime/supervisor.ts](src/runtime/supervisor.ts) — delete `DEFAULT_MODEL`, `DEFAULT_INTERVAL_MS`, `DEFAULT_THRESHOLD`, `DEFAULT_LOG_LINES` and the `?? DEFAULT_…` chains (Zod schema default already covers; these are dead). `FORCE_CANCEL_DELAY_MS` read from `config.runtime.supervisor.forceCancelDelayMs`. (F04 owns the model-string side.)
- [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts) — delete `DEFAULT_SCAN_MODEL` and `DEFAULT_MAX_SCAN_CHARS` (same dead-fallback pattern; F04 owns the model.)
- [src/runtime/notes.ts](src/runtime/notes.ts) — `DEFAULT_VOLATILE_TTL_MS` becomes a constructor argument sourced from `config.runtime.notes.volatileTtlMs`; the `static readonly` field stays only if a caller passes no config (constructor still takes a default).
- [src/server/bootstrap.ts](src/server/bootstrap.ts) — `RECOVERY_DELAY_MS` reads `config.runtime.recoveryDelayMs`; thread `SaivageConfig` into `McpRuntime` constructor.
- [src/mcp/runtime.ts](src/mcp/runtime.ts) — `IN_PROCESS_TIMEOUT_MS` and `SHELL_TIMEOUT_MS` come from constructor `config.mcp.*` (still `private readonly`, no longer `static`).
- [src/mcp/builtins.ts](src/mcp/builtins.ts) — `MAX_OUTPUT`, `MAX_FETCH_CHARS`, `MAX_DOWNLOAD_BYTES` become parameters of the builtins-factory; `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS` env handling deleted (replaced by `config.mcp.shellTimeoutFloorMs`). `MAX_WALL_CLOCK_MS` keeps deriving from shell timeout but the derivation moves to F12's territory; F11 just notes the dependency.
- Everything else in the F11 inventory stays as `const … = X` at module scope with a name that already says what it is (most already have one). Rename function-local `const`s in [src/agents/base.ts](src/agents/base.ts#L478-L480) and [src/agents/planner.ts](src/agents/planner.ts#L192) to module-scope `const`s for visibility; no behaviour change.
- **Keep the `EventBus` constructor `handlerTimeoutMs` parameter.** It is a real test seam used by [src/events/bus.test.ts](src/events/bus.test.ts#L154-L167) (`new EventBus(10)` + fake timers) so the resume-timeout test can complete in milliseconds instead of 5 seconds. Removing it would either (a) make that test wait on a real 5 s timer (slow, flaky), (b) require monkey-patching the module const (ugly), or (c) require deleting the assertion (loses coverage of a real failure mode). Treat it on par with `BaseAgent.transientCap`'s subclass-override seam.
- **Keep `BaseAgent.transientCap` getter**: tests override it via subclass; it's a real seam.
- Web SPA: out of scope for `SaivageConfig` (config doesn't reach the bundle without a build-time pipeline). Note as candidate for a tiny `web/src/composables/usePollInterval.ts` shared module in a follow-up; do NOT introduce that file as part of F11. The duplicated `8000` literals across three views are a real micro-issue but a separate cleanup.

**Risk:** Low. Most changes are mechanical const renames within a file. The four promoted keys are well-bounded; defaults match today's behaviour exactly. One real risk: dropping `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS` is a small operator-facing change — call it out in the plan; the test [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts) sets it and must be updated. Project policy explicitly allows breaking changes; an env-var-only knob nobody documents publicly is a clean candidate for removal.

**What it enables:**
- F04 cleanup is easier (the `?? DEFAULT_…` pattern goes away here).
- F12 has a single source of truth for shell timeout (it now lives in config).
- F20: when `maxContextTokens` becomes per-model, the MCP output caps (already in config) can be re-derived in one place.
- F33: keeps the config-default surface small enough that drift stays auditable.

**What it forbids:**
- Promoting any further internal control-loop constant without an operator scenario.
- Re-introducing module-level `DEFAULT_*` fallbacks for values whose Zod schema already provides a default.
- Dropping test seams (`transientCap`, `EventBus.handlerTimeoutMs`) without an equivalent in-test injection mechanism.

**Recommendation note:** **chosen**. Aligns with the "over-engineering" tag, removes more code than it adds, and exposes only the knobs that have a stated operator scenario.

## Proposal C — Curated middle: promote about half

**Scope (files touched):**

Same as B for the MCP block, plus also promote:

- `agent.loop.{baseBackoffSeconds, backoffMult, maxBackoffSeconds}` (the BaseAgent backoff triple), reasoning: slow links want longer initial backoff.
- `providers.router.requestTimeoutMs` (real operator concern: long-running cloud-LLM requests on flaky connections).
- `chat.maxPendingMessages` (UX choice).

Keep inline (and keep the `EventBus` test seam intact, same as Proposal B):

- All `MAX_INVALID_*`, `MAX_NUDGES`, `MAX_DIAGNOSTIC_ENTRIES`, `MAX_CONSECUTIVE_INVALID`, `transientCap`.

**Risk:** Medium. The agent-backoff and router-backoff knobs *look* operator-facing but in practice they overlap (both retry the same call). Promoting both is the wrong shape; you want one unified retry policy, not two. That unification is its own refactor and shouldn't be glued onto F11.

**What it enables:** Marginally more tunability than B for two scenarios (very slow links, very chatty Telegram users).

**What it forbids:** Same as B.

**Recommendation note:** runner-up. If/when an operator actually files a "I need to tune backoff for my flaky link" ticket, promote the BaseAgent backoff triple then (with a unified retry-policy fix that also handles `providers.router`). Doing it now is speculative.

## Recommendation

**Proposal B**. The honest answer to "should these be in config?" is: a small minority should be, the majority are internal control-loop ceilings that are correctly placed inline, and several existing inline fallbacks are *dead code* because the Zod schema already supplies the default. The level-up move is to (a) delete the dead fallbacks, (b) promote only the four-to-six knobs an operator actually has a reason to tune, and (c) rename a few function-local `const`s to module-scope for visibility. This removes more code than it adds and shrinks the config surface that F33 has to keep in sync.
