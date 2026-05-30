# G07 — Plan r1

**Finding**: [../G07-compaction-fallback-orphan-tool-results.md](../G07-compaction-fallback-orphan-tool-results.md)
**Analysis**: [./01-analysis-r1.md](./01-analysis-r1.md)
**Design**: [./02-design-r1.md](./02-design-r1.md) — Proposal B (round-parser).

## Steps

1. **Add `Round` model and parser.** In [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts), introduce module-local types `type Round = { kind: "text"; messages: [Message] } | { kind: "tool"; messages: [Message, Message]; toolIds: Set<string> }` and a `parseRounds(messages: Message[]): Round[]` function. Pairing rule: an assistant message whose `content` array contains ≥1 `tool_use` blocks is paired with the next message iff that next message has `role === "user"` and its block array contains a `tool_result` for every `tool_use.id` in the assistant message; partial matches do not pair (the assistant message becomes a `text` round only if it also has text blocks, otherwise it is dropped). Any user message with `tool_result` blocks not consumed by a pair is dropped on parse.

2. **Add round selector.** Add `selectKeptRounds(rounds: Round[], config: CompactionConfig, router: ModelRouter, modelSpec: string, systemPrompt: string): Round[]` that accumulates rounds from the tail until either (a) `≥ max(2, ceil(rounds.length * 0.2))` rounds are kept, or (b) the running token count of the flattened kept set drops below `0.5 * config.thresholdPct/100 * config.contextWindow`. Always keep at least one round when input is non-empty. Use `router.countTokens(modelSpec, flat, systemPrompt)` for the token axis.

3. **Add `flatten`.** `flatten(rounds: Round[]): Message[]` concatenates `r.messages` in order.

4. **Rewrite the fallback.** Replace the `catch (err)` body of `compactConversation` at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L102-L123) with:
   - Call the optional `config.fallbackSummarizerSpec` summarizer once with the same `raceTimeout` if the field is set; on success, take the success path (early return as today).
   - Otherwise: `const kept = selectKeptRounds(parseRounds(messages), config, router, modelSpec, systemPrompt);` and return `[noticeMessage, ...flatten(kept)]`.
   - Do **not** increment `state.compactionCount` on this branch.
   - Increment `state.summarizerFallbacks` (new field) and call `config.onFallback?.({ error: err, keptRounds: kept.length })` if the callback is set.

5. **Extend `CompactionConfig` and `CompactionState`.** In [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L10-L26), add `fallbackSummarizerSpec?: string` and `onFallback?: (info: { error: unknown; keptRounds: number }) => void` to `CompactionConfig`; add `summarizerFallbacks: number` to `CompactionState`. Initialise the counter to `0` at every call site that constructs the state object.

6. **Wire the callback in BaseAgent.** In `compactWithReinjection` at [src/agents/base.ts](../../../../src/agents/base.ts#L856-L890), pass `onFallback` into the `compactConversation` call: implementation calls `this.addDiagnostic("model_repair", "Summarizer fallback used (round-parser truncation). keptRounds=…")`. Initialise `summarizerFallbacks: 0` wherever `compactionState` is constructed (search consumers of `CompactionState` and update all). Do not change the existing `isMaxCompactionsReached` callers at [src/agents/base.ts](../../../../src/agents/base.ts#L240-L247) and [src/agents/base.ts](../../../../src/agents/base.ts#L544-L552).

7. **Expose fallback counter via runtime-state.** In [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts) wherever the per-agent payload is assembled for `writeRuntimeState`, include `summarizer_fallbacks: state.summarizerFallbacks` alongside the existing compaction-count field. If the agent surface that reaches `recovery.ts` does not expose the counter today, route it through the same accessor that already exposes `compactionCount`.

8. **Optional plumbing for `fallbackSummarizerSpec`.** In [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts), read an optional `SaivageConfig.fallback_summarizer_model_spec` (string) and pass it through when building each agent's `CompactionConfig`. If the field is not defined in [src/types.ts](../../../../src/types.ts) `SaivageConfig` schema yet, add it as `z.string().optional()`. If the operator-facing config addition is judged out of scope by the reviewer, drop this step and ship steps 1–7 only — the orphan-fix is independent of this opt-in.

9. **Delete the old fallback heuristic.** Remove the inline `Math.max(2, Math.ceil(messages.length * 0.2))`, `messages.slice(-keepCount)`, and the inline `state.compactionCount++` from the catch branch at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L106-L110). Architecture-first; no compatibility shim.

10. **Replace compaction tests.** In [src/runtime/compaction.test.ts](../../../../src/runtime/compaction.test.ts):
    - Add a `describe("parseRounds")` block with cases: text-only conversation; one tool round; missing-result orphan (assistant tool_use followed by plain text user); missing-use orphan (lone tool_result); interleaved text and tool rounds.
    - Add a `describe("compactConversation fallback")` block with a `router.chat` mock that rejects, seeded with both orphan modes; assert the returned `Message[]` is pair-valid (helper `assertNoOrphans(messages)`), that `state.compactionCount` is **unchanged**, and that `state.summarizerFallbacks === 1`.
    - Keep the existing `shouldCompact` tests.

11. **Extend BaseAgent compaction tests.** In [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts), add a test where the test router throws on the summarizer call. Seed a transcript with a tool-pair tail using `agent.seedMessage` for both halves. After `runCompaction`, assert: (a) `agent.getMessages()` is pair-valid; (b) no `tool_result` with an unmatched `tool_use_id` remains; (c) the diagnostic stream contains `"Summarizer fallback used"`.

12. **Type-check, lint, unit-test.** From `/home/salva/g/ml/saivage`: `npx tsc --noEmit`, `npx eslint .`, `npx vitest run src/runtime/compaction.test.ts src/agents/base.compaction.test.ts`.

## Validation

- **Unit**: the new tests above must pass; vitest in CI mode (`npx vitest run`) must remain green for the whole repo.
- **Build**: `npm run build` (or `npx tsup`) succeeds; no new TS errors elsewhere from the `CompactionConfig` / `CompactionState` shape changes.
- **Live, manual, against `saivage-v3` container only** (per workspace handoff):
  1. Read `WORKSPACE_HANDOFF.md` and the `.saivage/runtime/runtime-state.json` of [/home/salva/g/ml/saivage-v3/.saivage](../../../../../saivage-v3/.saivage) before any restart.
  2. Rebuild on host: `cd /home/salva/g/ml/saivage && npm run build`.
  3. `ssh root@10.0.3.112 systemctl restart saivage.service`.
  4. `curl -fsS http://10.0.3.112:8080/health` → 200.
  5. Drive a long-context planner conversation (≥80% of the configured `contextWindow`) via the dashboard; while it runs, force a summarizer fault by temporarily routing the summarizer spec to a non-existent profile (or kill the upstream provider). Confirm in logs that `[compaction] Summarization failed` appears, that the agent does **not** terminate with `max_compactions`, that the next `router.chat` succeeds without a `400 invalid_request_error`, and that `summarizer_fallbacks` shows up in the runtime-state payload.
  6. Restore the summarizer spec; confirm the next compaction takes the success path.
- **Do not** restart `saivage` (10.0.3.111) or `diedrico` (10.0.3.113) for this finding's validation. They share the bind-mounted `saivage` source so the binary is already updated, but they own unrelated long-running stage state per the workspace handoff. Restart them only with operator approval and against their own runtime-state checkpoints.

## Rollback

- Single revert: this change touches `src/runtime/compaction.ts`, `src/agents/base.ts` (callback wiring only), `src/runtime/recovery.ts` (one field), optionally `src/server/bootstrap.ts` and `src/types.ts`, plus two test files. `git revert <merge-sha>` restores the prior behaviour wholesale. Rebuild and `ssh root@10.0.3.112 systemctl restart saivage.service`; the runtime-state JSON is forward-compatible (the new `summarizer_fallbacks` field disappears on read because nothing consumes it).
- **No data-format rollback needed**: there is no on-disk schema change beyond the optional new field in `SaivageConfig`. If step 8 was taken, also delete `fallback_summarizer_model_spec` from any operator-owned `.saivage/saivage.json` files **before** reverting — but do not read or print those files (workspace policy).
- If a partial rollback is preferred (keep the round-parser, drop the counter wiring), revert only the change to [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts) and the `addDiagnostic` callback in [src/agents/base.ts](../../../../src/agents/base.ts#L856-L890); leave [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts) on the new code. The repaired-fallback half is the high-value, low-blast-radius part.

## Cross-finding

- **G06 — stash uses sync fs.** A slow disk in [src/runtime/stash.ts](../../../../src/runtime/stash.ts) stretches tool-call latency, increasing the chance the summarizer hits `raceTimeout` at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L155-L166). The two fixes are independent but G06 should land first so the live-validation in §Validation is exercising the orphan-repair path on its own merits rather than masking a flaky timer.
- **G29 — plan-server serialize-blocks-reads.** Same shape: when the summarizer competes with planner reads, the summarizer latency window widens. Not blocking, but should be referenced in the post-merge note so an operator who sees a spike in `summarizer_fallbacks` knows to check whether G29 has shipped.
- **F13 (round 1) — typed `ProviderError`.** This plan relies on `pe.kind === "orphaned_tool_result"` at [src/agents/base.ts](../../../../src/agents/base.ts#L539-L559) continuing to fire when a downstream provider rejects an orphan. Do not weaken `ORPHAN_RE` in [src/providers/error.ts](../../../../src/providers/error.ts#L79) without re-testing this path; the round-parser closes the producer side, but the consumer side is still the last line of defence.
- **G05 / G01 (worker-message duplication / roster).** No coupling; both finding sets touch agent surfaces but not [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts).
