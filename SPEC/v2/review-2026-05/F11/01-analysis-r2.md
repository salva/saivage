# F11 — Analysis r2

## Changes from r1

- **Corrected the `EventBus` caller inventory.** r1 said "constructor override exists, no caller uses it". That is wrong: [src/events/bus.test.ts](src/events/bus.test.ts#L154-L167) constructs `new EventBus(10)` with fake timers to verify that `resume()`'s buffered handler delivery honours the timeout. Production callers ([src/server/bootstrap.ts](src/server/bootstrap.ts#L192), and the two test instantiations in [src/agents/agents.test.ts](src/agents/agents.test.ts#L321) and [src/agents/agents.test.ts](src/agents/agents.test.ts#L365)) all use the default, so the parameter is a **test seam**, not configurability for absent callers.
- Updated the "Constraints any solution must respect" list to require preserving (or explicitly replacing) the `EventBus` timeout test seam, by analogy with the already-protected `BaseAgent.transientCap` subclass-override seam.
- Tightened the inventory row for `EventBus.DEFAULT_HANDLER_TIMEOUT_MS` to record the actual usage.

No other content changes; the rest of the r1 analysis (classification by Class 1–5, file:line inventory) stands.

## Problem restated

`SaivageConfig` exposes some operational knobs (`runtime.healthCheckIntervalMs`, `supervisor.intervalMs`, `agent.maxConcurrentAgents`, `security.maxScanLengthBytes`, etc.) but many other operational constants live inline as module-scoped consts. The issue ticket frames this as "they should all be in config". This analysis argues the framing is itself the over-engineering, and what we actually have is two distinct problems mixed together:

1. **Genuinely tunable constants** that an operator might want to override per deployment (a handful).
2. **Internal control-loop constants** that nobody but the implementer ever needs to set, and that current callers never override anyway (most of them).

Treating both alike — by promoting every constant to `SaivageConfig` — would multiply schema surface, defaults drift (cf. F33), and create the same "every place reads its own default" failure mode that F04 already documents for hardcoded models.

The actual inventory in the repo is broader than the F11 ticket lists. Below is the verified set with current values and call sites.

## Verified inventory

### Runtime / agent control loop

| Constant | Value | Where | Currently overridable? |
|---|---|---|---|
| `MAX_NUDGES` | `15` | [src/agents/planner.ts](src/agents/planner.ts#L192) (function-local `const`) | No |
| `Dispatcher.MAX_CONSECUTIVE_INVALID` | `3` | [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L66) | No |
| `BaseAgent.MAX_INVALID_FINAL_RESPONSES` | `3` | [src/agents/base.ts](src/agents/base.ts#L126) | No |
| `MAX_DIAGNOSTIC_ENTRIES` | `30` | [src/agents/base.ts](src/agents/base.ts#L83) | No |
| `BaseAgent.transientCap` (getter) | `500` | [src/agents/base.ts](src/agents/base.ts#L700-L702) | Only via subclass override (tests do this: [src/agents/conversation-snapshot.test.ts](src/agents/conversation-snapshot.test.ts#L32-L37)) |
| `BASE_DELAY_S`, `BACKOFF_MULT`, `MAX_DELAY_S` | `30`, `1.5`, `1200` | [src/agents/base.ts](src/agents/base.ts#L478-L480) (function-local) | No |
| `ChatAgent.MAX_PENDING_MESSAGES` | `5` | [src/agents/chat.ts](src/agents/chat.ts#L134) | No |
| `FORCE_CANCEL_DELAY_MS` | `600_000` (10 min) | [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L12) | No |
| `RECOVERY_DELAY_MS` | `60_000` | [src/server/bootstrap.ts](src/server/bootstrap.ts#L494) | No |
| `PLANNER_SHUTDOWN_TIMEOUT_MS` | `30_000` (function-local) | [src/server/cli.ts](src/server/cli.ts#L373) | No |
| Supervisor in-file defaults `DEFAULT_INTERVAL_MS`, `DEFAULT_THRESHOLD`, `DEFAULT_LOG_LINES` | mirror config schema | [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L9-L11) | Mirror only (config already wins via Zod default) |

### Notes / store

| Constant | Value | Where |
|---|---|---|
| `NoteManager.DEFAULT_VOLATILE_TTL_MS` | `2 * 60 * 60 * 1000` (2 h) | [src/runtime/notes.ts](src/runtime/notes.ts#L60) |
| `LOG_BUFFER_LIMIT` | `2_000` | [src/log.ts](src/log.ts#L18) |
| `EventBus.DEFAULT_HANDLER_TIMEOUT_MS` | `5000` | [src/events/bus.ts](src/events/bus.ts#L54-L57). Constructor parameter `handlerTimeoutMs` defaults to this constant. Used as a **test seam** in [src/events/bus.test.ts](src/events/bus.test.ts#L154-L167) (`new EventBus(10)` with fake timers, to exercise buffered-handler timeout during `resume()`). No production caller overrides it: [src/server/bootstrap.ts](src/server/bootstrap.ts#L192), [src/agents/agents.test.ts](src/agents/agents.test.ts#L321), [src/agents/agents.test.ts](src/agents/agents.test.ts#L365) all use `new EventBus()`. |

### MCP runtime + tool ceilings

| Constant | Value | Where |
|---|---|---|
| `McpRuntime.IN_PROCESS_TIMEOUT_MS` | `300_000` (5 min) | [src/mcp/runtime.ts](src/mcp/runtime.ts#L168) |
| `McpRuntime.SHELL_TIMEOUT_MS` | `4 * 60 * 60 * 1000` (4 h) | [src/mcp/runtime.ts](src/mcp/runtime.ts#L171) |
| `MAX_OUTPUT` | `100 * 1024` | [src/mcp/builtins.ts](src/mcp/builtins.ts#L33) |
| `PROCESS_KILL_GRACE_MS` | `2_000` | [src/mcp/builtins.ts](src/mcp/builtins.ts#L34) |
| `OUTPUT_GROWTH_POLL_MS` | `1_000` | [src/mcp/builtins.ts](src/mcp/builtins.ts#L35) |
| `MAX_WALL_CLOCK_MS` | `SHELL_TIMEOUT_MS - 30_000` | [src/mcp/builtins.ts](src/mcp/builtins.ts#L39) |
| `MAX_FETCH_CHARS` | `200_000` | [src/mcp/builtins.ts](src/mcp/builtins.ts#L40) |
| `MAX_DOWNLOAD_BYTES` | `250 * 1024 * 1024` | [src/mcp/builtins.ts](src/mcp/builtins.ts#L41) |
| `MAX_SCAN_DECODE_BYTES` | `1_000_000` | [src/mcp/builtins.ts](src/mcp/builtins.ts#L42) |
| `DEFAULT_MIN_TIMEOUT_MS` (shell floor) | `10 * 60 * 1000`, overridable via `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS` env | [src/mcp/builtins.ts](src/mcp/builtins.ts#L377-L408) |

### Provider routing

| Constant | Value | Where |
|---|---|---|
| `PROVIDER_REQUEST_TIMEOUT_MS` | `300_000` | [src/providers/router.ts](src/providers/router.ts#L18) |
| `PRIMARY_RETRY_BASE_DELAY_MS`, `_BACKOFF_MULT`, `_MAX_DELAY_MS` | `30_000`, `1.5`, `1_200_000` | [src/providers/router.ts](src/providers/router.ts#L19-L21) |
| `ModelRouter.INITIAL_BACKOFF_MS`, `BACKOFF_MULTIPLIER`, `MAX_BACKOFF_MS` | `15_000`, `1.5`, `600_000` | [src/providers/router.ts](src/providers/router.ts#L88-L92) |

### Security

| Constant | Value | Where | Already partially in config? |
|---|---|---|---|
| `DEFAULT_SCAN_MODEL` | `"github-copilot/gpt-5.4"` | [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L26) | Yes (`security.injectionModel`) — duplication is F04's problem, not F11's |
| `DEFAULT_MAX_SCAN_CHARS` | `100_000` | [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L27) | Yes (`security.maxScanLengthBytes`) — local default is dead unless config schema default is removed |

### Compaction

| Constant | Value | Where |
|---|---|---|
| Token estimator divisor `chars/4` | `4` | [src/runtime/compaction.ts](src/runtime/compaction.ts#L24) |
| Compaction `thresholdPct` | `80`, `maxCompactions` `3` (default in `BaseAgent`) | [src/agents/base.ts](src/agents/base.ts#L188-L194) — *already* sourced from `ctx.project.config.agents[role]` per-agent |
| `summaryTimeoutMs` default in compaction config | `1_200_000` (commented; not enforced) | [src/runtime/compaction.ts](src/runtime/compaction.ts#L38) |

### Channels

| Constant | Value | Where |
|---|---|---|
| `TG_MAX_LENGTH` | `4096` (Telegram protocol limit) | [src/channels/telegram.ts](src/channels/telegram.ts#L21) |

### Web SPA

| Constant | Value | Where |
|---|---|---|
| `INITIAL_BACKOFF_MS`, `MAX_BACKOFF_MS`, `BACKOFF_FACTOR` | `1_000`, `30_000`, `1.7` | [web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts#L11-L13) |
| Title poll `8000` ms | inline literal | [web/src/App.vue](web/src/App.vue#L144) |
| Status poll `4000` / clock `1000` ms | inline literals | [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L76-L77) |
| Debug poll `8000` ms | inline literal | [web/src/components/DebugView.vue](web/src/components/DebugView.vue#L66) |
| Plan poll `8000` ms | inline literal | [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L105) |
| Agents poll `5000` / clock `1000` ms | inline literals | [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L279-L280) |

Note: a number of file:line references in [F11-magic-constants-not-in-config.md](../F11-magic-constants-not-in-config.md) are off by a few lines (e.g. `MAX_NUDGES` is at L192 not L223; `MAX_CONSECUTIVE_INVALID` at L66 not L68; `MAX_INVALID_FINAL_RESPONSES` at L126 not L131; `App.vue` poll at L144 not L150). The constants exist; the ticket pre-dates a refactor.

## Actual classification

Group by "could an operator ever rationally want to change this for a particular deployment?":

### Class 1 — Pure internal control-loop tuning, nobody overrides

`MAX_NUDGES`, `MAX_CONSECUTIVE_INVALID`, `MAX_INVALID_FINAL_RESPONSES`, `MAX_DIAGNOSTIC_ENTRIES`, `ChatAgent.MAX_PENDING_MESSAGES`, `BASE_DELAY_S`/`BACKOFF_MULT`/`MAX_DELAY_S` in `BaseAgent.callLLM`, `PROCESS_KILL_GRACE_MS`, `OUTPUT_GROWTH_POLL_MS`, `MAX_SCAN_DECODE_BYTES`, `LOG_BUFFER_LIMIT`, `transientCap = 500`, `PLANNER_SHUTDOWN_TIMEOUT_MS`.

These are stop-the-bleeding ceilings whose exact value is essentially arbitrary; operators have no signal to set them differently. Promoting them is pure surface bloat.

`EventBus.handlerTimeoutMs` is also Class-1 from an operator perspective (no operator scenario for tuning it), but is **kept as a test seam** rather than collapsed to a plain inline const — see Constraints below.

### Class 2 — Coupled invariants that should be derived, not set independently

`MAX_WALL_CLOCK_MS = SHELL_TIMEOUT_MS - 30_000` — this is F12's territory; F11 should *not* try to fix it by adding two configurable knobs (that just lets operators break the invariant). The fix is in F12.

`DEFAULT_INTERVAL_MS`, `DEFAULT_THRESHOLD`, `DEFAULT_LOG_LINES`, `DEFAULT_SCAN_MODEL`, `DEFAULT_MAX_SCAN_CHARS` — these are *redundant module-level fallbacks* for values that are already non-optional in the Zod schema. The `?? DEFAULT_…` chains in [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L51-L53) and [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L59-L61) are dead because Zod always fills the default. They should be deleted.

### Class 3 — Genuinely operator-facing, deserves config

- `McpRuntime.IN_PROCESS_TIMEOUT_MS` and `McpRuntime.SHELL_TIMEOUT_MS` — operators *do* care: a slow CI box, an experiment that legitimately needs >4 h, or a paranoid policy that caps at 30 min, all have a real reason to override. F12 also needs these as the single source of truth.
- `MAX_OUTPUT`, `MAX_FETCH_CHARS`, `MAX_DOWNLOAD_BYTES` — these set context-fill cost vs result-fidelity tradeoffs that differ between a constrained-context model deployment and a 1M-context one. Cross-link F20: once `maxContextTokens` is model-aware, these caps want to be either operator-set or derived from it.
- `NoteManager.DEFAULT_VOLATILE_TTL_MS` — note ergonomics; operators on long-running deployments may want this longer/shorter.
- `RECOVERY_DELAY_MS` (planner recovery wait) — directly affects perceived responsiveness after a crash.
- `FORCE_CANCEL_DELAY_MS` (supervisor re-cancel grace) — coupled to user expectations for how long "graceful" stop should take.
- Provider-router timeouts and backoffs (`PROVIDER_REQUEST_TIMEOUT_MS`, `PRIMARY_RETRY_*`, `INITIAL_BACKOFF_MS`/`MAX_BACKOFF_MS`) — bandwidth-/quota-sensitive. But: these duplicate the agent-level backoff with very similar values. The fix is to *unify* them (one set of values, used in one place), not to expose two parallel knobs.

### Class 4 — Protocol/wire constants

`TG_MAX_LENGTH = 4096` (Telegram-imposed), `RESPONSES_ITEM_ID_LIMIT = 64` (OpenAI Responses-imposed). Never configurable; keep inline. Out of scope.

### Class 5 — Web SPA polling

The duplicated poll intervals (8s in three views; 4s in StatusPanel; 5s in AgentsView; 1s clocks in two) are an SPA-only problem and one of "share a constant + maybe replace polling with WS events", not "add to `SaivageConfig`" — config doesn't reach the SPA without an extra round-trip and a server-rendered injection. Mention only as a constants-deduplication candidate; defer the WS-vs-poll question to a separate ticket.

## Contract

This issue does not own a single contract; it modifies surface in several modules. The effective contract for any solution:

- `SaivageConfig` continues to validate via Zod at load time.
- No new runtime behaviour: defaults must reproduce the values that ship today.
- No backward-compat shims (project policy): if a config key is renamed/removed, callers update in the same change.
- Tests that depend on overriding internal limits must keep their override hook or get an equivalent replacement: `BaseAgent.transientCap` subclass-override seam used by [src/agents/conversation-snapshot.test.ts](src/agents/conversation-snapshot.test.ts#L32-L37); `EventBus.handlerTimeoutMs` constructor seam used by [src/events/bus.test.ts](src/events/bus.test.ts#L154-L167).

## Call sites & dependencies

- Anything promoted to `SaivageConfig` flows through `loadConfig()` ([src/config.ts](src/config.ts#L189-L207)). Consumers already accept a `SaivageConfig` in their constructor (supervisor, prompt-injection-cop, BaseAgent context).
- `McpRuntime` does *not* currently receive a `SaivageConfig` — promoting timeouts means threading config to it in [src/server/bootstrap.ts](src/server/bootstrap.ts) where it is constructed.
- `EventBus` is constructed at [src/server/bootstrap.ts](src/server/bootstrap.ts#L192) with no arguments today; the only argument-bearing caller is the timeout test in [src/events/bus.test.ts](src/events/bus.test.ts#L154-L167).
- F04 (default models): the Class 2 deletion of `DEFAULT_SCAN_MODEL` / `DEFAULT_INTERVAL_MS` style fallbacks is the same pattern F04 needs.
- F20 (`maxContextTokens` per-model): the Class 3 tool-output caps want to be informed by a real model context window once F20 lands.
- F12 (cross-file MCP magic coupling): the shell timeout pair must be a single source.
- F33 (default project config drift in `cli.ts initProject`): every new config knob is another opportunity for `initProject` to drift from `config.ts` defaults.

## Constraints any solution must respect

1. **No backward-compat aliases**: if `DEFAULT_SCAN_MODEL` etc. are deleted, callers stop referencing them in the same commit; no `@deprecated` ladder.
2. **No premature configurability**: each promoted knob must have a stated operator scenario; "for symmetry" is not a reason.
3. **No new docstring/comments on code not otherwise touched** (project rule).
4. **Test hooks preserved**: `BaseAgent.transientCap` getter and `EventBus` constructor `handlerTimeoutMs` parameter are existing seams that real tests use. Do not remove them outright; if an equivalent injection mechanism would be cleaner, replace them in the same change and update the test, but do not drop the seam and leave the test relying on real-time waits.
5. **Defaults must match today's behaviour** — no opportunistic value changes hidden inside a "make it configurable" diff.
6. **Skills/memory code is out of scope** (`src/skills/`, related SPEC dirs).
