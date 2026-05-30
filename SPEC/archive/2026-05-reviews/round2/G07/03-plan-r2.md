# G07 — Plan r2

**Finding**: [../G07-compaction-fallback-orphan-tool-results.md](../G07-compaction-fallback-orphan-tool-results.md)
**Analysis**: [./01-analysis-r2.md](./01-analysis-r2.md)
**Design**: [./02-design-r2.md](./02-design-r2.md) — Proposal B (round-parser), with bounded fallback escape, real token-budget selector, and concrete runtime-state plumbing.
**Supersedes**: [./03-plan-r1.md](./03-plan-r1.md). Addresses changes 1, 2, 4, 5, 6 of [./04-review-r1.md](./04-review-r1.md).

## Steps

1. **Add `Round` model and `parseRounds`.** In [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts), introduce module-local types `type Round = { kind: "text"; messages: [Message] } | { kind: "tool"; messages: [Message, Message]; toolIds: Set<string> } | { kind: "dangling"; messages: [Message] }` and the `parseRounds(messages: Message[]): Round[]` function defined in [./02-design-r2.md](./02-design-r2.md) §2.2. Pairing requires set-equality between the assistant's `tool_use.id` set and the next user message's `tool_result.tool_use_id` set; partial matches produce `dangling`. Single forward walk, total, order-preserving.

2. **Add `selectKeptRounds` with real token budget.** Add `selectKeptRounds(rounds: Round[], opts: SelectOpts): { kept: Round[]; oversizedAtomic: boolean }` per [./02-design-r2.md](./02-design-r2.md) §2.3. `SelectOpts` carries `config: CompactionConfig`, `router: ModelRouter`, `modelSpec: string`, `systemPrompt: string`, `tools: ToolSchema[] | undefined`. Budget = `floor(thresholdPct/100 * contextWindow) - SAFETY_MARGIN_TOKENS` (constant `1024`). Walk tail-first, prepend candidate, recompute `router.countTokens(modelSpec, flatten(kept), systemPrompt, tools)`, accept while projected ≤ budget; stop on first reject. If the very first candidate alone exceeds budget, force-keep it and set `oversizedAtomic = true`. Always drop `dangling`.

3. **Add `flatten`.** `flatten(rounds: Round[]): Message[]` concatenates `r.messages` in order. Pure.

4. **Extend `CompactionConfig` and `CompactionState`.** In [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L10-L26):
   - `CompactionConfig`: add `maxConsecutiveFallbacks: number` (no default in the type; the constructor passes `3`).
   - `CompactionState`: add `summarizerFallbacks: number`, `consecutiveFallbacks: number`, `oversizedAtomicFallback: boolean`. Initialise all to `0` / `false` at every state-construction site.

5. **Extend `isMaxCompactionsReached`.** At [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L52-L57), change to `return state.compactionCount >= config.maxCompactions || state.consecutiveFallbacks >= config.maxConsecutiveFallbacks || state.oversizedAtomicFallback === true`. Callers at [src/agents/base.ts](../../../../src/agents/base.ts#L240-L247) and [src/agents/base.ts](../../../../src/agents/base.ts#L544-L552) keep their call shape.

6. **Rewrite the success and fallback branches of `compactConversation`.** Replace the `try`/`catch` body at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L84-L123):
   - **Success branch** (after `state.compactionCount++`): also set `state.consecutiveFallbacks = 0` and `state.oversizedAtomicFallback = false`. Return value unchanged.
   - **Fallback branch** (catch): `state.summarizerFallbacks++`; `state.consecutiveFallbacks++`. Do **not** increment `state.compactionCount`. Compute `const { kept, oversizedAtomic } = selectKeptRounds(parseRounds(messages), { config, router, modelSpec, systemPrompt, tools });`. If `oversizedAtomic`, set `state.oversizedAtomicFallback = true`. Return `[noticeMessage, ...flatten(kept)]` (the existing notice string at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L113-L116) is reused). If `kept` is empty, return just `[noticeMessage]`. Invoke `config.onFallback?.({ error: err, keptRounds: kept.length, oversizedAtomic })` if set.

7. **Add `onFallback` and `onCompactionUpdate` callback surface.** Add `onFallback?: (info: { error: unknown; keptRounds: number; oversizedAtomic: boolean }) => void` to `CompactionConfig`. No callback leak to agent state — purely a function reference passed in.

8. **Wire callbacks in `BaseAgent`.**
   - In the constructor at [src/agents/base.ts](../../../../src/agents/base.ts#L191-L196), add `maxConsecutiveFallbacks: 3` to `this.compactionConfig`. Initialise `this.compactionState = { compactionCount: 0, summarizerFallbacks: 0, consecutiveFallbacks: 0, oversizedAtomicFallback: false }` at [src/agents/base.ts](../../../../src/agents/base.ts#L146).
   - In `compactWithReinjection` at [src/agents/base.ts](../../../../src/agents/base.ts#L856-L890), pass `onFallback: (info) => this.addDiagnostic("model_repair", `Summarizer fallback (round-parser truncation). keptRounds=${info.keptRounds}${info.oversizedAtomic ? ", oversized atomic round" : ""}.`)` into the `compactConversation` call. After the await returns, invoke `this.config.onCompactionUpdate?.(this.id, { count: this.compactionState.compactionCount, summarizerFallbacks: this.compactionState.summarizerFallbacks, consecutiveFallbacks: this.compactionState.consecutiveFallbacks, oversizedAtomicFallback: this.compactionState.oversizedAtomicFallback })`.
   - In the abort diagnostics at [src/agents/base.ts](../../../../src/agents/base.ts#L240-L247) and [src/agents/base.ts](../../../../src/agents/base.ts#L544-L552), emit a reason-specific message: pick from `"max compactions exceeded"`, `"summarizer fallback exhausted"`, or `"oversized atomic tool round (use stash)"` based on which of the three stop conditions is true. The `finishReason` field stays `"max_compactions"` (broader contract is unchanged).
   - Add `onCompactionUpdate?: (agentId: string, c: { count: number; summarizerFallbacks: number; consecutiveFallbacks: number; oversizedAtomicFallback: boolean }) => void` to `BaseAgentConfig` (search the `BaseAgentConfig` type definition and update it; pass-through wiring at every construction site).

9. **Extend `AgentStateSchema` and `RuntimeTracker`.**
   - In [src/types.ts](../../../../src/types.ts#L240-L247), add the optional `compaction` field per [./02-design-r2.md](./02-design-r2.md) §2.6 step 1.
   - In [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts#L338-L370), add `agentCompactionUpdate(agentId, c)`: if `this.frozen || !this.agents.has(agentId)` return; otherwise mutate the existing `AgentState` entry's `compaction` field with snake_case shape `{ count, summarizer_fallbacks, consecutive_fallbacks, oversized_atomic_fallback }`; call `this.flush()`. `snapshot()` at [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts#L395-L404) already serialises `active_agents: [...this.agents.values()]`, so the field flows through automatically once present on the map entry.
   - In [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts), at the per-agent `BaseAgentConfig` construction site, bind `onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker)`. Same pattern as `onActivity`.

10. **Delete the old fallback heuristic.** Remove `Math.max(2, Math.ceil(messages.length * 0.2))`, `messages.slice(-keepCount)`, and the inline `state.compactionCount++` from the catch branch at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L106-L110). Architecture-first; no compatibility shim.

11. **Replace compaction tests.** In [src/runtime/compaction.test.ts](../../../../src/runtime/compaction.test.ts):
    - Add `describe("parseRounds")`: text-only conversation (only `TextRound`s); one clean tool round (`ToolRound` with set equality); assistant `tool_use` followed by a plain-text user (yields `DanglingHalf` for the assistant); lone `tool_result` user with no preceding `tool_use` (yields `DanglingHalf` for the user); two interleaved tool rounds with text rounds between; assistant with text + tool_use blocks where the next user matches (yields `ToolRound`); partial-match case where the next user covers only some `tool_use.id`s (yields two `DanglingHalf`s); duplicate `tool_use.id` within one assistant message (set equality still holds).
    - Add `describe("selectKeptRounds")`: budget-fit case where multiple rounds fit and tail-most are kept; budget-tight case where exactly one round fits; oversized-atomic case (single `ToolRound` larger than budget alone) returns `{ kept: [thatRound], oversizedAtomic: true }`; `DanglingHalf`-only input returns `{ kept: [], oversizedAtomic: false }`; tool schemas and system prompt are included in the projected token count (test asserts that adding a large tool schema reduces the number of accepted rounds vs. an empty schema set).
    - Add `describe("compactConversation fallback")` with a `router.chat` mock that rejects on the summarizer call and resolves on `countTokens`. Seed with a conversation whose tail is a complete tool pair so the leading-`tool_result` orphan is exercised. Assert: returned `Message[]` is pair-valid via a local `assertNoOrphans(messages)` helper that walks blocks and checks every `tool_result` has a preceding `tool_use` with matching id; `state.compactionCount` is **unchanged**; `state.summarizerFallbacks === 1`; `state.consecutiveFallbacks === 1`.
    - Add `describe("compactConversation fallback exhaustion")` that calls `compactConversation` three times with a still-throwing summarizer and a tiny `contextWindow` so the result never fits the budget. Assert `state.consecutiveFallbacks === 3` and `isMaxCompactionsReached(state, config) === true` even though `state.compactionCount === 0`.
    - Add `describe("compactConversation oversized atomic round")` that seeds a single `ToolRound` whose flattened token count alone exceeds the budget; assert `state.oversizedAtomicFallback === true` and `isMaxCompactionsReached(state, config) === true`.
    - Keep the existing `shouldCompact` tests.

12. **Extend BaseAgent compaction tests.** In [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts):
    - Add a test where the test router throws on the summarizer call. Seed a transcript with a tool-pair tail (assistant `tool_use` + user `tool_result`). After `runCompaction` (or equivalent harness call), assert:
      - `agent.getMessages()` is pair-valid (use the same `assertNoOrphans` helper from step 11).
      - `agent.compactionState.compactionCount` is **unchanged**.
      - `agent.compactionState.summarizerFallbacks === 1`.
      - `agent.getConversationSnapshot()` (the dashboard surface at [src/agents/base.ts](../../../../src/agents/base.ts#L363-L461)) contains a `model_repair` diagnostic with the substring `"Summarizer fallback"`.
    - Add a test that constructs a `RuntimeTracker` against a temp `.saivage` dir, wires `onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker)` into the agent config, registers the agent via `tracker.agentStarted`, forces one fallback, then reads the `runtime-state.json` written by the tracker and asserts `active_agents[0].compaction.summarizer_fallbacks === 1` (change 4 testability requirement).
    - Add a test for fallback exhaustion: same setup as above but the router throws three times in a row and `contextWindow` is set so the post-fallback transcript never fits. Assert the agent exits the loop with `finishReason === "max_compactions"` and the abort diagnostic message contains `"summarizer fallback exhausted"`.

13. **Type-check, lint, unit-test.** From `/home/salva/g/ml/saivage`: `npx tsc --noEmit`, `npx eslint .`, `npx vitest run src/runtime/compaction.test.ts src/agents/base.compaction.test.ts`.

## Validation

- **Unit**: every test from steps 11–12 passes; `npx vitest run` for the whole repo stays green.
- **Build**: `npm run build` (or `npx tsup`) succeeds; no new TS errors from `CompactionConfig` / `CompactionState` / `AgentStateSchema` shape changes (search every consumer of `CompactionState` and update construction sites).
- **Schema parsing**: a pre-existing `runtime-state.json` (no `compaction` field on any `active_agents` entry) still parses cleanly because the field is `.optional()`. Verified by a dedicated test that loads a recorded fixture from before the change.
- **Live, manual, against `saivage-v3` container only** (per workspace handoff; change 6):
  1. Read [WORKSPACE_HANDOFF.md](../../../../../WORKSPACE_HANDOFF.md) and the existing `.saivage/runtime/runtime-state.json` at [/home/salva/g/ml/saivage-v3/.saivage](../../../../../saivage-v3/.saivage) before any restart.
  2. Rebuild on host: `cd /home/salva/g/ml/saivage && npm run build`.
  3. `ssh root@10.0.3.112 systemctl restart saivage.service`.
  4. `curl -fsS http://10.0.3.112:8080/health` → 200.
  5. Smoke-check by querying `curl -fsS http://10.0.3.112:8080/api/runtime-state | jq '.active_agents[]?.compaction'` after a normal planner round; the field should appear (possibly all zeros) on any agent that has executed `compactWithReinjection` once. If no compaction has run yet, the field stays absent — that is correct.
  - **No live fault injection.** Do not reroute the summarizer spec to a non-existent profile and do not kill any upstream provider. The summarizer-failure path is proven by the in-process integration test in step 12, which uses a deterministic throwing router. Live provider-routing mutation requires explicit operator authorisation and is out of scope for an automated G07 task.
- **Do not** restart `saivage` (10.0.3.111) or `diedrico` (10.0.3.113) for this finding's validation. Their on-disk binary updates automatically through the `/home/salva/g/ml/saivage` bind mount when the host build completes, but their long-running stage state is unrelated to G07; restarting them requires operator approval and a separate runtime-state checkpoint per the workspace handoff.

## Rollback

- Single revert: this change touches `src/runtime/compaction.ts`, `src/agents/base.ts`, `src/runtime/recovery.ts`, `src/types.ts`, `src/server/bootstrap.ts`, and the two test files. `git revert <merge-sha>` restores the prior behaviour wholesale. Rebuild and `ssh root@10.0.3.112 systemctl restart saivage.service`. The `compaction` field on `AgentStateSchema` was added as `.optional()`, so on-disk `runtime-state.json` files written under the new code parse cleanly under the old schema (the unknown field is ignored by zod's default `strip` mode at parse time).
- **No data-format rollback needed**. There is no on-disk schema change beyond an additive optional field. No operator-owned config field was added (change 5: `fallbackSummarizerSpec` is dropped from this round), so there is nothing for the operator to clean up in `.saivage/saivage.json`.
- Partial rollback path (keep round-parser, drop runtime-state plumbing): revert the changes to [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts), [src/types.ts](../../../../src/types.ts), and the `onCompactionUpdate` wiring in [src/agents/base.ts](../../../../src/agents/base.ts) and [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts). Leave [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts) on the new code; the orphan-correctness and bounded-fallback-escape pieces are the high-value, low-blast-radius core.

## Cross-finding

- **G06 — stash uses sync fs.** A slow disk in [src/runtime/stash.ts](../../../../src/runtime/stash.ts) can stretch tool-call latency and push summarizer calls past `raceTimeout` at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L155-L166). **Not a dependency** of G07 (change 6 / cross-finding note). The orphan-correctness fix and the bounded-fallback escape must hold regardless of why the summarizer failed. G06 may ship before, after, or independently.
- **G29 — plan-server serialize-blocks-reads.** Same shape: summarizer competes with planner reads on the same model spec, inflating timeout-driven fallback frequency. **Not a dependency.** Reference G29 in the post-merge note so an operator who sees a spike in `summarizer_fallbacks` knows to check whether G29 has shipped.
- **F13 (round 1) — typed `ProviderError`.** This plan relies on `pe.kind === "orphaned_tool_result"` at [src/agents/base.ts](../../../../src/agents/base.ts#L539-L559) continuing to fire when a residual orphan from a prior broken run reaches the next `router.chat` call. Do not weaken `ORPHAN_RE` at [src/providers/error.ts](../../../../src/providers/error.ts#L79) without re-testing this path; the round-parser closes the producer side, the discriminant is the consumer side. Both must hold.
- **G05 / G01 (worker-message duplication / roster).** No coupling; both finding sets touch agent surfaces but not [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts).
