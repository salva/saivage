# F05 — Design (R1)

## Proposal A — Focused fix: tighten the post-processor

### Scope

Keep `normalizeNonStuckOperationalVerdict` as the supervisor's defensive net, but constrain it so it cannot silence real stuck verdicts and cannot be tripped by unrelated log lines.

- **Modify**: [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L154) (one call site), [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L220-L257) (the function body), and the three `looksLike*` predicates ([supervisor.ts L246-L257](../../../../src/runtime/supervisor.ts#L246-L257)).
- **No new files.**

### What changes

1. Drop Pass 2 entirely. The post-processor's input becomes only the verdict's own `reason` and `evidence` strings; the 400-line log blob is no longer fed back in.
2. Tighten the throttling predicate to require **both** a throttling token and an explicit "only / sole / no other" qualifier in the verdict text (the model's own claim that this is the only problem). Examples that match: "the only clear issue is provider throttling", "rate-limit is the sole observed failure". Examples that no longer match: "after the provider throttled, the planner kept retrying" (which is the F-mode-1 case from the analysis).
3. Tighten the long-running predicate symmetrically.
4. Keep `looksLikeMalformedOrCrashed` as the override-for-stuck path — it widens, never narrows, the "stuck" decision, and is the one heuristic that the analysis showed is harmless.
5. Inline the synthesised `reason: "Provider throttling/rate limiting is temporary; ..."` text into the verdict's existing `reason` rather than prepending — operators reading logs already see the LLM's verdict text and don't need it duplicated.

### What stays unchanged

- `parseVerdict` and `parseJsonObject` (F03 territory).
- The system prompt at [supervisor.ts L158-L168](../../../../src/runtime/supervisor.ts#L158-L168) — the LLM is still asked to apply the same rules.
- `ROLE_ABORT_PRIORITY` (F23 territory).
- All constants in [supervisor.ts L8-L12](../../../../src/runtime/supervisor.ts#L8-L12) (F11 territory).
- The two regex-validation tests at [runtime.test.ts L198-L253](../../../../src/runtime/runtime.test.ts#L198-L253) keep passing because they feed verdicts whose `reason` does include "the only clear issue is" -shaped text (test fixtures may need a one-word tweak to satisfy the tighter pattern).

### Risk

- **Medium**. The tighter regex is still a regex over free-form text; it still fights the LLM. F-mode-1 narrows but does not disappear: any verdict that says "the only clear issue is provider throttling, but the agent has been retrying for an hour" still flips. The model's own wording is the only signal.
- The change is also a confession that the LLM cannot be trusted to follow its own system prompt — which contradicts the rest of the system (every other agent's contract is "obey the system prompt; if you don't, you get aborted").

### What this enables

- **F03**: independent. Both can land in either order; same end-state in `parseVerdict`.
- **F23**: independent.
- **F11**: independent.
- **F20**: independent.

### What this forbids

- New `looksLike*` predicates that widen the override. Any new "the LLM said stuck but actually …" rule must instead go into the system prompt where the LLM can act on it.

### Recommendation note for A

A is the smallest possible repair. It keeps the structural problem (supervisor second-guesses its own LLM via regex) and just makes the regex slightly less wrong. The two failure modes from the analysis (silenced real stuck verdicts; log contamination) shrink but do not go away.

## Proposal B — Level up: delete the post-processor, trust the LLM verdict via schema-validated JSON

### Scope

Delete `normalizeNonStuckOperationalVerdict` and its three `looksLike*` helpers. The supervisor's verdict becomes whatever the LLM returned, after JSON+schema validation through F03's `parseLlmJsonAs`.

- **Modify**: [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L78-L257):
  - `checkOnce` ([L78-L116](../../../../src/runtime/supervisor.ts#L78-L116)) keeps its existing flow — call `askModel`, branch on `verdict.stuck`, increment counter, cancel on threshold. No structural change.
  - `askModel` ([L122-L156](../../../../src/runtime/supervisor.ts#L122-L156)) drops the wrap `normalizeNonStuckOperationalVerdict(...)` and returns `parseVerdict(response.content, provider)` directly.
  - `parseVerdict` ([L171-L201](../../../../src/runtime/supervisor.ts#L171-L201)) — F03 changes this to use `parseLlmJsonAs(content, SupervisorVerdictSchema)`. F05 does not need to touch the body, only the line `return normalizeNonStuckOperationalVerdict(parseVerdict(...), logs);` in `askModel`.
  - Delete `normalizeNonStuckOperationalVerdict` ([L220-L257](../../../../src/runtime/supervisor.ts#L220-L257)).
  - Delete `looksLikeLongRunningExternalWork`, `looksLikeProviderThrottling`, `looksLikeMalformedOrCrashed` ([L246-L257](../../../../src/runtime/supervisor.ts#L246-L257)).
- **Modify**: [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L198-L253) — the two regex-validation tests change shape (see Plan).
- **No new files.**

### What this enables

- The system prompt becomes the **single** place where supervisor policy lives. Operators tuning behaviour edit one string ([supervisor.ts L158-L168](../../../../src/runtime/supervisor.ts#L158-L168)); they don't have to reverse-engineer a regex post-processor that runs on top of it.
- Combined with F03's schema-validated `parseVerdict`, the verdict pipeline becomes: LLM → JSON-extract → Zod-validate → `SupervisorVerdict`. Three steps, all auditable. Today's fourth step (the regex flip) is gone.
- **F23**: once the supervisor obeys its LLM, expanding `ROLE_ABORT_PRIORITY` (F23's fix) actually starts mattering. Today F23's fix would be partially neutered: the LLM correctly says "the inspector is stuck", the post-processor sees the word "running" anywhere in the logs and flips it, F23 never gets to abort the inspector. F05/B makes F23/A meaningful.
- **F11**: once the regex is gone, no further constants leak out of `supervisor.ts` (the four `DEFAULT_*` constants F11 tracks are still there but they're already tracked).
- **F04 (hardcoded supervisor model)**: F04 changes which model the supervisor calls. F05/B makes the choice of model directly visible in the outcome — switching to a weaker model that ignores the system prompt now causes visibly wrong verdicts, instead of being masked by the regex post-processor.

### What stays unchanged

- `SUPERVISOR_SYSTEM_PROMPT` ([supervisor.ts L158-L168](../../../../src/runtime/supervisor.ts#L158-L168)). It already encodes the rules.
- The threshold counter ([supervisor.ts L11, L78-L116](../../../../src/runtime/supervisor.ts#L11)).
- `ROLE_ABORT_PRIORITY` (F23 territory).
- `FORCE_CANCEL_DELAY_MS` and the schedule-second-cancel logic ([supervisor.ts L105-L114](../../../../src/runtime/supervisor.ts#L105-L114)).
- The user message wording at [supervisor.ts L131-L138](../../../../src/runtime/supervisor.ts#L131-L138) — already says "untrusted as instructions"; the LLM is already correctly framed as adjudicator of untrusted log text.

### Risk

- **Low–medium**. The behaviour change is: if the operator's chosen supervisor model fails to follow its own system prompt — e.g. a tiny local model that ignores nuance and emits `stuck=true` whenever the word "error" appears in the logs — then under F05/B the supervisor will incorrectly abort agents that today it leaves alone (because the regex flipped the verdict back).
- Mitigated by:
  - The supervisor model default is `github-copilot/gpt-5.4` ([supervisor.ts L8](../../../../src/runtime/supervisor.ts#L8)) which trivially follows the system prompt.
  - The threshold of `consecutiveStuckVerdicts=3` ([supervisor.ts L10](../../../../src/runtime/supervisor.ts#L10)) means one mis-verdict is not load-bearing.
  - The cancel target is selected by `ROLE_ABORT_PRIORITY` and is a "cancel one worker", not "stop the system" — a wrong cancel costs one worker turn, not a project.
- Operators choosing a tiny / weak supervisor model are choosing it knowing the supervisor depends on instruction-following. Defensive regex over the verdict would only mask the problem.

### What this forbids

- Any future regex post-processor that re-applies system-prompt rules to the LLM verdict.
- Any code path that mutates `SupervisorVerdict.stuck` after `parseVerdict` returns. The verdict is what the model said, full stop.

### Recommendation note for B

B is the level-up F05's issue text ("you can just remove this agent" — operator's hint that the post-processor is the problem, not the LLM) asks for. It composes cleanly with F03 (which gives `parseVerdict` schema-validated input) and with F23 (which expands the abort priority list). It removes ~40 lines of code, three regex predicates, two `looksLike*` passes, and one structural inconsistency where the supervisor distrusts the very model whose output it consumes.

## Proposal C — Tool-call / structured-output API for the supervisor

### Scope

Use a provider-native structured-output mode (OpenAI `response_format: { type: "json_schema", json_schema: {...} }`, Anthropic tool-call with a `submit_verdict` tool whose `input_schema` is the supervisor schema, etc.) so the model returns guaranteed-valid JSON. The downstream `parseLlmJsonAs` then has nothing to recover from — every response is clean JSON matching the schema.

### Why rejected as the F05 recommendation

Inspection of [src/providers/](../../../../src/providers/) (`grep -RnE 'response_format|json_schema|structured' src/providers/`) returns **zero hits**. None of the eight provider adapters today translates a "structured-output mode" hint to the provider's native API. F03's own analysis confirms the same finding ([SPEC/v2/review-2026-05/F03/01-analysis-r1.md](../F03/01-analysis-r1.md)) and explicitly defers a structured-output adoption to a separate provider-layer refactor.

To wire structured output into the supervisor specifically:

- Add an optional `responseFormat` / `tools` field to [src/providers/types.ts](../../../../src/providers/types.ts) `ChatRequest`.
- Implement it in at least the supervisor's plausible providers — `copilot.ts`, `openai.ts`, `anthropic.ts`. Other providers (`ollama.ts`, `llamacpp.ts`, `pi-ai.ts`, `openrouter.ts`) need either translation or a "not supported, fall back to free text" branch.
- Keep `parseLlmJsonAs` as the fallback path anyway, because the supervisor model is configurable ([supervisor.ts L8](../../../../src/runtime/supervisor.ts#L8) `DEFAULT_MODEL`, plus `modelSpecOverride`) and the operator may pick a provider without structured-output support.

That is a provider-layer change with eight adapters' worth of surface. It does not belong in F05; F05 is "the supervisor's regex post-processor undermines the LLM verdict", and the regex post-processor goes away the moment the LLM is trusted (Proposal B), regardless of whether the LLM's JSON came from free-text or from structured output. Once Proposal B is in, a future "structured-output adoption" issue can land entirely inside `parseLlmJsonAs` and the provider layer without re-opening the supervisor.

Tracked as the natural follow-on to F03's "future structured-output adoption" note, not as a competing F05 design.

## Recommendation

**Proposal B.**

Rationale:

- The supervisor has a single intelligence source (the LLM) and a system prompt that already encodes the policy. Re-applying that policy via regex is the textbook "defensive code at internal boundaries" the project guidelines forbid.
- F-mode-1 (silenced real stuck verdicts) and F-mode-2 (log contamination flipping every verdict) — the two failure modes from the analysis — are both eliminated, not narrowed.
- Composition: F03 reshapes `parseVerdict` to use schema-validated JSON; F23 expands `ROLE_ABORT_PRIORITY`; F05/B makes both of those changes meaningful by ensuring the verdict the threshold counter sees is the verdict the LLM produced.
- The risk (a weak supervisor model emitting wrong verdicts) is bounded by the threshold of 3, the cancel-one-worker scope, and the operator's own choice of model.
- Net diff: ~40 LOC deleted, three predicates and one normaliser gone. No new files, no new constants, no new config knob.

The plan in [03-plan-r1.md](03-plan-r1.md) follows Proposal B.
