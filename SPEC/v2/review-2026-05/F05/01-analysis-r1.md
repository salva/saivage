# F05 — Functional analysis (R1)

## Problem restated

`RuntimeSupervisor.askModel` ([src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L122-L156)) does three things in order:

1. Pulls recent log entries via `getRecentLogs(this.logLines)` ([src/log.ts](../../../../src/log.ts#L35)) and joins their `formatted` lines into one blob.
2. Sends them to the supervisor LLM with a system prompt that explicitly enumerates the rules "treat throttling/rate-limit/quota/429/overload as stuck=false" and "treat long-running shell/training/benchmark/build/test/playwright work as stuck=false" ([src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L158-L168)).
3. Parses the model reply into a `SupervisorVerdict`, then **runs `normalizeNonStuckOperationalVerdict(verdict, logs)`** ([src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L154)) which can flip `stuck=true` back to `stuck=false` based on regex heuristics over the verdict text and the log blob.

The post-processor body ([src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L220-L257)) tries three regex predicates in two passes:

- Pass 1: against `verdictText = verdict.reason + verdict.evidence.join("\n")`.
- Pass 2: against `combined = verdictText + "\n" + logs`.

Each pass:

- If `looksLikeMalformedOrCrashed(value)` matches (`Unterminated string|Unexpected end of JSON|malformed|No tool call found|orphaned tool|context_length_exceeded|exceeds the context window|unhandled exception|unhandled rejection|TypeError|ReferenceError|SyntaxError|crash|failed to parse`) → leave `stuck=true`.
- Else if `looksLikeLongRunningExternalWork(value)` matches → flip to `stuck=false` with a synthesised reason "Long-running external work is not itself stuck.".
- Else if `looksLikeProviderThrottling(value)` matches (`rate-limit(ed|ing)?|throttl(ed|ing)|too many requests|\b429\b|quota|temporar(y|ily) unavailable|capacity|overloaded`) → flip to `stuck=false` with reason "Provider throttling/rate limiting is temporary; not treating as stuck.".

The two passes are not equivalent: Pass 2 widens the input by the entire 400-line log blob (`DEFAULT_LOG_LINES=400`, [supervisor.ts L11](../../../../src/runtime/supervisor.ts#L11)). So any earlier unrelated log line that contains the substring "throttl" or "capacity" or "training" or "running" will satisfy the predicate on Pass 2 even when the verdict itself is talking about something else.

## Why this is a bug, not a safety net

The system prompt at [supervisor.ts L158-L168](../../../../src/runtime/supervisor.ts#L158-L168) already instructs the LLM:

> "If the only clear issue is model-provider throttling, rate limiting, quota exhaustion, 429, temporary capacity, or provider overload, mark stuck=false because Saivage should wait and retry. If the only clear issue is a long-running external process, shell command, data download, training job, experiment, build, test, benchmark, or web/browser task, mark stuck=false because long-running work is not itself stuck"

So `normalizeNonStuckOperationalVerdict` re-applies the rules the LLM was already told to apply. Two failure modes:

- **F-mode-1 (silenced real stuck verdict)**: the LLM correctly identifies a real persistent retry loop where the underlying cause is "the planner is stuck repeatedly invoking an agent that keeps emitting malformed tool calls **after** the provider also throttled once". The verdict text might mention "after the provider rate-limited the planner kept retrying"; this contains `rate-limit` and (per Pass 1) flips to `stuck=false`. The actual problem — the planner can't recover from malformed tool calls — never reaches the threshold. The abort that should rescue the system never fires.
- **F-mode-2 (logs contaminate the verdict)**: Pass 2 mixes the verdict with 400 lines of unrelated log output. Any deployment that runs a long-lived `training` script or whose log buffer happens to contain a stale "rate-limited, trying next" entry will have **every** stuck verdict flipped, regardless of what the LLM actually said. Operators see "supervisor never aborts anything" as a configuration property of their workload, not as a supervisor bug.

The supervisor's own counter `consecutiveStuckVerdicts` ([supervisor.ts L11](../../../../src/runtime/supervisor.ts#L11), default `3`) compounds the problem: the flip resets the counter via the `if (!verdict.stuck)` branch at [supervisor.ts L82-L88](../../../../src/runtime/supervisor.ts#L82-L88). One flipped verdict undoes two prior real-stuck verdicts.

## Contract

The supervisor produces one of two observable effects per `checkOnce()` tick:

- Increments `consecutiveStuck`. When it reaches `threshold` (`config.supervisor.consecutiveStuckVerdicts ?? 3`), it picks an agent per `ROLE_ABORT_PRIORITY` ([supervisor.ts L13-L19](../../../../src/runtime/supervisor.ts#L13-L19)) and calls `target.agent.cancel()` ([supervisor.ts L103](../../../../src/runtime/supervisor.ts#L103)) and schedules a second `.cancel()` after `FORCE_CANCEL_DELAY_MS = 600_000` ms ([supervisor.ts L12, L105-L114](../../../../src/runtime/supervisor.ts#L12)).
- Or resets the counter to 0 (if `verdict.stuck === false`).

That is it. The supervisor does not write tool calls, does not modify state, does not interact with the dispatcher. The verdict consumption path is direct:

- Verdict produced → counter mutated → optional `BaseAgent.cancel()` invocation → BaseAgent sets `this.cancelled = true` ([src/agents/base.ts](../../../../src/agents/base.ts#L206-L208)) → the agent's `runLoop` ([src/agents/base.ts](../../../../src/agents/base.ts#L209-L216)) sees the flag at its next iteration and exits.

There is no dispatcher-side handling of verdicts. The F05 prompt asked me to check `src/runtime/dispatcher.ts`; the verdict path does not pass through it. Recording this as a negative finding so a future reader does not search for one.

The shape the LLM must emit (per the system prompt):

```
{"stuck": true|false, "confidence": 0..1, "reason": "short reason", "evidence": ["short log evidence"]}
```

`parseVerdict` ([supervisor.ts L171-L201](../../../../src/runtime/supervisor.ts#L171-L201)) defends against non-JSON via the F03-identified private `parseJsonObject` helper ([supervisor.ts L204-L218](../../../../src/runtime/supervisor.ts#L204-L218)). On any non-object content it synthesises a `stuck=true, confidence=0.4` verdict using the raw content as evidence — this is the supervisor's only "escalate on parse failure" path.

## Call sites & dependencies

- Producer of the post-processor's input:
  - `parseVerdict(response.content, provider)` ([supervisor.ts L156](../../../../src/runtime/supervisor.ts#L156)).
  - `getRecentLogs(this.logLines)` ([supervisor.ts L123-L125](../../../../src/runtime/supervisor.ts#L123-L125)).
- Consumer of the (post-processed) verdict:
  - `checkOnce()` itself ([supervisor.ts L78-L116](../../../../src/runtime/supervisor.ts#L78-L116)). No external consumer.
- `normalizeNonStuckOperationalVerdict` has zero callers outside `supervisor.ts` (`grep -RnE 'normalizeNonStuckOperationalVerdict' src/` → only the function definition and its single call site at L154).
- `looksLikeMalformedOrCrashed`, `looksLikeLongRunningExternalWork`, `looksLikeProviderThrottling` are module-private and only called from `normalizeNonStuckOperationalVerdict`.
- Tests that exercise the post-processor:
  - [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L198-L225) — "does not cancel agents when the only reported problem is provider throttling": feeds the LLM verdict `{stuck: true, reason: "GitHub Copilot is returning 429 rate limit responses", evidence: ["provider throttling"]}` and asserts `cancel` was not called. **The verdict comes in as `stuck=true`; only the post-processor flips it.** This test exists specifically to lock in the current behaviour.
  - [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L226-L253) — long-running shell command variant of the same pattern.
  - [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L116-L148) — happy-path `stuck=true, reason: "retry loop"`: verdict is plain enough that no `looksLike*` regex matches and the counter increments normally.
  - [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L150-L172) — three consecutive `stuck=true` verdicts cause cancel. Same pattern.

Any change to F05 has to address those two "throttling / long-running" tests. They are not load-bearing for correctness; they exist to assert the regex post-processor flips. If the post-processor goes away, the tests must change shape: feed `stuck=false` directly (which is what the LLM is supposed to emit per its own prompt) and assert no cancel — i.e. the test becomes "supervisor obeys the LLM verdict it received" instead of "supervisor overrides the LLM via regex".

- F03 territory: `parseVerdict` and its private `parseJsonObject` helper are inside F03's nine-site sweep ([SPEC/v2/review-2026-05/F03/01-analysis-r1.md](../F03/01-analysis-r1.md) Axis 1 + Axis 2). F05 must coordinate with F03's parser change to avoid two simultaneous edits to the same function.
- F23 territory: the `ROLE_ABORT_PRIORITY` list is incomplete (no `inspector`, no `chat`, no `planner`). F05 does not touch the priority list; F23 owns it.
- F11 territory: `DEFAULT_MODEL`, `DEFAULT_INTERVAL_MS`, `DEFAULT_THRESHOLD`, `DEFAULT_LOG_LINES`, `FORCE_CANCEL_DELAY_MS` ([supervisor.ts L8-L12](../../../../src/runtime/supervisor.ts#L8-L12)) are F11's territory. F05 does not move them into `SaivageConfig`; the regex thresholds inside `looksLike*` are not part of F11's table.
- F20 territory: `maxTokens: 600` ([supervisor.ts L153](../../../../src/runtime/supervisor.ts#L153)) is the only token budget in `askModel`. Sufficient for the small JSON verdict today and after F05.

## Constraints any solution must respect

- **Architecture-first, no backward compatibility** ([_LOOP-CONVENTIONS.md](../_LOOP-CONVENTIONS.md)). If the post-processor goes, it goes entirely — no transitional "warn-only" flag, no `if (config.supervisor.legacyRegexFilter)` switch.
- **Trust the LLM at the system boundary**: the supervisor's input is a model the operator chose; its job is to apply the rules in its system prompt. Re-applying them with regex is the kind of defensive-at-internal-boundary code the project guidelines call out.
- **No new docstrings on untouched code**: only the supervisor functions that change get new comments.
- **F03 sequencing**: F03 deletes `parseJsonObject` and replaces `parseVerdict` with a `parseLlmJsonAs(content, schema)` call ([SPEC/v2/review-2026-05/F03/03-plan-r1.md](../F03/03-plan-r1.md) Step 7). F05's changes to `askModel` and `normalizeNonStuckOperationalVerdict` are disjoint from F03's changes to `parseVerdict`, but both touch the same file. Sequencing matters only for merge convenience.
- **F23 independence**: F23 expands the abort priority list but does not touch the verdict pipeline. F05 and F23 can land in either order; both reduce the supervisor's behavioural gap.
- **Tests must follow the new contract**: the two regex-validation tests at [runtime.test.ts L198-L253](../../../../src/runtime/runtime.test.ts#L198-L253) are testing the wrong contract (they assert the supervisor overrides the LLM). They must be rewritten to test the right contract: when the LLM returns `stuck=false` for throttling/long-running scenarios, the supervisor does not cancel.
- **No emojis** anywhere.
