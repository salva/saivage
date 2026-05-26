# G07 — Design r2

**Finding**: [../G07-compaction-fallback-orphan-tool-results.md](../G07-compaction-fallback-orphan-tool-results.md)
**Analysis**: [./01-analysis-r2.md](./01-analysis-r2.md)
**Supersedes**: [./02-design-r1.md](./02-design-r1.md). This revision addresses changes 1, 2, 4, 5, 6, 7 of [./04-review-r1.md](./04-review-r1.md).

Proposal B (round-parser) is the chosen direction; Proposal A is explicitly rejected on order/adjacency correctness grounds. The optional fallback-summarizer-spec plumbing is **removed** from this round (change 5).

---

## 1. Why Proposal A is rejected (change 7)

Proposal A in r1 ([./02-design-r1.md](./02-design-r1.md#L9-L48)) keeps `slice(-keepCount)` and runs a two-pass `repairToolPairs` that collects every assistant `tool_use.id` into a `Set<string>` and filters user `tool_result` blocks against the set. This is **not order-aware**: a `tool_result` early in the kept window can match a `tool_use` that appears later in the same window, and A would keep both. That preserves a `tool_result` block whose matching `tool_use` does not yet appear in any preceding assistant turn, which still violates both provider invariants:

1. **Order**: Anthropic and OpenAI both require `tool_use` to precede the matching `tool_result` in message order. A's Set lookup ignores indices.
2. **Adjacency**: providers require the `tool_result` user message to *immediately* follow the assistant `tool_use` message it answers (it is the same conversational round). A's symmetric backward pass does not enforce adjacency either; a stray text message between the two halves of a pair would not be removed, but the provider still treats the pair as ill-formed.

A also leaves the 20% heuristic intact, which is independently rejected by change 2: the heuristic is unanchored to the next outbound request's token budget (system prompt + tools + flattened kept rounds).

Proposal B treats a tool round as the atomic unit, so the order and adjacency invariants are preserved by construction. A is rejected; B is the chosen direction.

---

## 2. Proposal B — Round-parser with budgeted selector and bounded fallback escape

### 2.1 Round model

A `Round` is one of:

- **TextRound** — a single `user`, `assistant`, or `system` message whose content is a string, or an array containing only `text` / `thinking` blocks. Atomic.
- **ToolRound** — an `assistant` message containing ≥1 `tool_use` blocks, followed immediately by exactly one `user` message whose `tool_result` blocks cover every `tool_use.id` from the assistant message. Atomic. Carries the set of tool-use ids for selector accounting.
- **DanglingHalf** — an assistant message with `tool_use` blocks not followed by a matching `tool_result` user message; or a user message with `tool_result` blocks not preceded by a matching `tool_use` assistant message. Never produced by `BaseAgent.run`'s happy path (see [./01-analysis-r2.md](./01-analysis-r2.md#L25-L41)); appears only as a tail when compaction fires mid-cycle or a previous broken fallback ran. `selectKeptRounds` always drops `DanglingHalf`.

### 2.2 `parseRounds(messages: Message[]): Round[]`

Single forward walk. State machine:

1. If the current message is `assistant` and `content` is an array containing ≥1 `tool_use` block:
   - Collect the set `T = {block.id | block.type === "tool_use"}`.
   - Peek the next message. If it is `user`, `content` is an array, the array contains at least one `tool_result`, and `{block.tool_use_id | block.type === "tool_result"} === T` (set equality), emit `ToolRound{ messages: [asst, user], toolIds: T }` and advance two messages.
   - Otherwise emit `DanglingHalf{ messages: [asst] }` and advance one message. (The assistant message may also contain text/thinking blocks; selector drops the whole half so the text is sacrificed — acceptable because the dangling case is a recovery artefact, not a steady-state producer path.)
2. If the current message is `user` and `content` is an array containing ≥1 `tool_result` block (and we did not arrive here by step 1 already consuming it), emit `DanglingHalf{ messages: [user] }` and advance one message.
3. Otherwise (text-only message, system message, string-content message): emit `TextRound{ messages: [msg] }` and advance one message.

Partial matches (the next user message covers a subset of `T`) are treated as `DanglingHalf` for the assistant side; the partial-result user message becomes its own `DanglingHalf` on the next iteration. Duplicate `tool_use.id` values within a single assistant message are not produced by the runtime but are tolerated — set equality collapses them. The function is total, order-preserving, and idempotent under round-trip through `flatten`.

### 2.3 `selectKeptRounds(rounds, opts): { kept: Round[]; oversizedAtomic: boolean }`

Real token-budget algorithm (change 2). The selector is given the full set of inputs the next outbound `router.chat` will incur:

```ts
interface SelectOpts {
  config: CompactionConfig;
  router: ModelRouter;
  modelSpec: string;
  systemPrompt: string;
  tools: ToolSchema[] | undefined;
}
```

Budget definition:

```
targetTokens = floor(config.thresholdPct / 100 * config.contextWindow) - SAFETY_MARGIN_TOKENS
```

`SAFETY_MARGIN_TOKENS = 1024` (module constant). This is the cap the post-fallback transcript must respect so the next pre-call `shouldCompact` check at [src/agents/base.ts](../../../../src/agents/base.ts#L237-L238) does **not** immediately re-fire.

Algorithm:

1. Drop every `DanglingHalf` from `rounds`. Call the result `atomic`.
2. If `atomic` is empty, return `{ kept: [], oversizedAtomic: false }`. The caller prepends the synthetic notice message only.
3. Walk `atomic` from the tail backwards, maintaining a deque `kept`. At each step, prepend the candidate round and recompute the projected total via `router.countTokens(modelSpec, flatten(kept), systemPrompt, tools)`. If the projected total stays `≤ targetTokens`, accept the round and continue. If it exceeds `targetTokens`, **reject** the candidate, stop the loop, and return the current `kept` (which by invariant fits the budget).
4. Special case — oversized atomic round. If `kept` is empty after step 3 (the very last round on its own already exceeds `targetTokens`), force-keep that single round and set `oversizedAtomic = true`. This is the one case the selector cannot satisfy the budget; the caller must propagate the signal (see §2.5).

Notes:

- Token cost is measured on the **projected outbound request** (system prompt + tool schemas + flattened kept rounds), matching the BaseAgent precomputation at [src/agents/base.ts](../../../../src/agents/base.ts#L204-L208) and the existing compaction accounting at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L76-L77). The old "20% by message count" heuristic and the impossible "drops below half threshold" rule from r1 are both deleted.
- No `Math.max(2, ceil(rounds.length * 0.2))` count floor. The count cap was a safety stop for a heuristic that no longer exists; budget alone is the axis.
- The walk is O(n²) in the worst case (recomputing token count per accepted round). `messages.length` at compaction time is bounded by the agent's prior history (~hundreds of messages); `router.countTokens` is tiktoken-backed (F07) and cheap. Acceptable for an off-LLM-path repair routine. A future optimisation can cache per-round token costs, but is not required for correctness.

### 2.4 `flatten(rounds: Round[]): Message[]`

Concatenate `r.messages` in order. Pure.

### 2.5 Bounded fallback escape path (change 1)

The fallback must not loop pre-call compaction indefinitely on a still-oversized result.

Add `summarizerFallbacks: number` and `consecutiveFallbacks: number` to `CompactionState`. Add `maxConsecutiveFallbacks: number` (default `3`) to `CompactionConfig`.

Bookkeeping:

- Success branch of `compactConversation`: `state.compactionCount++`; reset `state.consecutiveFallbacks = 0`.
- Fallback branch: `state.summarizerFallbacks++`; `state.consecutiveFallbacks++`. Do **not** increment `state.compactionCount` (change 4 honest-accounting). If `selectKeptRounds` returns `oversizedAtomic === true`, also set `state.oversizedAtomicFallback = true` (boolean flag, persists until next success).

Stop condition — extend `isMaxCompactionsReached`:

```
isMaxCompactionsReached(state, config) =
  state.compactionCount >= config.maxCompactions
  || state.consecutiveFallbacks >= config.maxConsecutiveFallbacks
  || state.oversizedAtomicFallback === true
```

The three terms cover the three failure modes:

1. `compactionCount` — successful summaries that did not shrink the transcript enough. Existing behaviour.
2. `consecutiveFallbacks` — summarizer persistently failing. New explicit cap; surfaces the right message ("summarizer fallback exhausted") rather than masquerading as "max compactions exceeded".
3. `oversizedAtomicFallback` — single tool round larger than the budget. Cannot be fixed by more compaction; the right fix is the stash mechanism at [src/runtime/stash.ts](../../../../src/runtime/stash.ts) on the tool-result side. Terminate the agent so the parent can route appropriately.

Both consumers at [src/agents/base.ts](../../../../src/agents/base.ts#L240-L247) and [src/agents/base.ts](../../../../src/agents/base.ts#L544-L552) keep their existing call shape (`if (isMaxCompactionsReached(...)) { ... abort }`); the predicate is extended internally. The abort diagnostic distinguishes the three reasons so the operator can tell summarizer-down from prompt-bloat from oversized-tool-result.

### 2.6 Runtime-state exposure (change 4)

The r1 design hand-waved a non-existent `compactionCount` accessor on `RuntimeTracker`. The current surface ([src/runtime/recovery.ts](../../../../src/runtime/recovery.ts#L331-L400)) snapshots only its internal `AgentState` values ([src/types.ts](../../../../src/types.ts#L240-L247)), and `BaseAgent.compactionState` is private at [src/agents/base.ts](../../../../src/agents/base.ts#L146). The concrete API change is:

**1. Extend `AgentStateSchema`** in [src/types.ts](../../../../src/types.ts#L240-L247):

```ts
export const AgentStateSchema = z.object({
  agent_type: z.enum(ALL_ROLES),
  agent_id: z.string(),
  status: z.enum(["running", "suspended", "idle"]),
  current_task_id: z.string().optional(),
  channel: z.string().optional(),
  started_at: z.string(),
  compaction: z.object({
    count: z.number().int().nonnegative().default(0),
    summarizer_fallbacks: z.number().int().nonnegative().default(0),
    consecutive_fallbacks: z.number().int().nonnegative().default(0),
    oversized_atomic_fallback: z.boolean().default(false),
  }).optional(),
});
```

The field is optional on the schema so older `runtime-state.json` files parse without migration (zod fills the default on read). Architecture-first: nothing reads the old absence as meaningful; absence simply means "agent has not reported yet".

**2. Add an explicit method to `RuntimeTracker`** in [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts):

```ts
agentCompactionUpdate(agentId: string, c: {
  count: number;
  summarizerFallbacks: number;
  consecutiveFallbacks: number;
  oversizedAtomicFallback: boolean;
}): void
```

Same shape as `agentActivity` ([src/runtime/recovery.ts](../../../../src/runtime/recovery.ts#L357-L362)): no-op if frozen or agent not registered; otherwise mutate the `AgentState` entry in `this.agents` and `flush()`. The snake_case → camelCase mapping happens at this boundary.

**3. Plumb the call from `BaseAgent`**. `BaseAgent` already receives a tracker callback wired through `config.onActivity` ([src/agents/base.ts](../../../../src/agents/base.ts#L150)). Add a parallel `config.onCompactionUpdate?: (agentId, c) => void` callback. `BaseAgent.compactWithReinjection` invokes the callback after `compactConversation` returns (success or fallback), passing the current `compactionState` shape. The bootstrap that constructs `BaseAgent` already constructs `RuntimeTracker`; bind `onCompactionUpdate` to `tracker.agentCompactionUpdate.bind(tracker)`.

**4. Test that proves the dashboard state is written.** The integration test in [./03-plan-r2.md](./03-plan-r2.md) step 11 forces the summarizer to throw, runs `compactWithReinjection`, reads `runtime-state.json` from a temp `.saivage` dir written by a real `RuntimeTracker` instance, and asserts `active_agents[0].compaction.summarizer_fallbacks === 1`. No live container restart is needed; the runtime-state path is constructor-injected.

This is the only runtime-state exposure for the round. No new top-level fields on `RuntimeStateSchema`. Diagnostics (`addDiagnostic("model_repair", ...)`) remain the primary user-visible signal in the conversation snapshot at [src/agents/base.ts](../../../../src/agents/base.ts#L363-L461); the runtime-state counters are for the dashboard tile.

### 2.7 Configuration surface (change 5)

**Drop `fallbackSummarizerSpec` from this round.** R1 left it as an "optional but cheap" step routed through a non-existent `SaivageConfig.fallback_summarizer_model_spec` key, and confused [src/types.ts](../../../../src/types.ts) `ProjectConfig` with [src/config.ts](../../../../src/config.ts#L62-L194) `SaivageConfig`. The orphan-correctness fix is independent of this opt-in and ships without it.

The only configuration touchpoint added by this design is `CompactionConfig.maxConsecutiveFallbacks` with a hardcoded default `3` in the `BaseAgent` constructor at [src/agents/base.ts](../../../../src/agents/base.ts#L191-L196), alongside the existing `thresholdPct` and `maxCompactions` reads from `agentConfig`. No new `SaivageConfig` or `ProjectConfig` field. No new operator-facing config. A follow-up finding may re-introduce a configurable alternate summarizer spec; not in scope here.

### 2.8 Files touched

- [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts) — add `Round` types, `parseRounds`, `selectKeptRounds`, `flatten`; rewrite `compactConversation` fallback branch; extend `CompactionConfig` (`maxConsecutiveFallbacks`) and `CompactionState` (`summarizerFallbacks`, `consecutiveFallbacks`, `oversizedAtomicFallback`); extend `isMaxCompactionsReached`.
- [src/agents/base.ts](../../../../src/agents/base.ts) — initialise `maxConsecutiveFallbacks` in the constructor; initialise the new `CompactionState` fields; wire `onCompactionUpdate` callback into `BaseAgentConfig` and into `compactWithReinjection`; extend the abort diagnostics at [src/agents/base.ts](../../../../src/agents/base.ts#L240-L247) and [src/agents/base.ts](../../../../src/agents/base.ts#L544-L552) to report which of the three stop conditions tripped.
- [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts) — add `agentCompactionUpdate`; persist the new field via `snapshot`.
- [src/types.ts](../../../../src/types.ts) — extend `AgentStateSchema` with the optional `compaction` object.
- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) — bind `onCompactionUpdate` to the tracker in the per-agent config construction. (Search consumers of `BaseAgentConfig` to ensure all construction sites pass the callback; only the bootstrap path needs it in production.)
- [src/runtime/compaction.test.ts](../../../../src/runtime/compaction.test.ts) — new test blocks per the plan.
- [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts) — extend per the plan.

### 2.9 Deletion list (no compatibility shim)

- `Math.max(2, Math.ceil(messages.length * 0.2))` heuristic and the `messages.slice(-keepCount)` line at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L106-L107).
- The inline `state.compactionCount++` in the catch at [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts#L110).
- Nothing else. The pre-existing successful-summary code path is unchanged.

### 2.10 Test impact

See [./03-plan-r2.md](./03-plan-r2.md) step 10 for the full test list. Acceptance conditions:

- B emits only `TextRound`s and complete adjacent `ToolRound`s; never a `DanglingHalf`.
- Either the result fits the next outbound request budget, or `oversizedAtomicFallback` is true and the agent exits via the bounded fallback-failure path (no infinite pre-call compaction loop).
- Successful summarisation does not advance `summarizerFallbacks`; fallback does not advance `compactionCount`.
- Runtime-state `active_agents[*].compaction.summarizer_fallbacks` increments on a fallback event.

---

## 3. Caveats for the implementer

### 3.1 Deployment scope (change 6)

The repository memory `saivage-v3-getrich-v2` is not directly relevant; however the source file `src/runtime/compaction.ts` lives under `/home/salva/g/ml/saivage`, which is bind-mounted into all three v2-using LXC containers (`saivage` 10.0.3.111, `diedrico` 10.0.3.113, `saivage-v3` 10.0.3.112). A rebuild on the host updates the binary for all three; only `saivage-v3` is restarted as part of this finding's validation, per the workspace handoff. `saivage` and `diedrico` own unrelated long-running stage state; **do not** restart them as part of G07 — they will pick up the binary at their next operator-approved restart cycle. The plan reflects this single-restart policy and is now consistent with the workspace handoff (change 6 contradiction fixed).

### 3.2 Live fault injection (change 6)

The r1 plan suggested temporarily rerouting the summarizer spec to a non-existent profile, or killing the upstream provider, to force the fallback path on a live container. Both mutate provider routing or destabilise an upstream the operator has not authorised us to touch. Drop the live fault-injection step. The plan replaces it with an in-process integration test using a fake `ModelRouter` whose `chat` throws on the summarizer call (step 11 of [./03-plan-r2.md](./03-plan-r2.md)). The live validation step keeps the build, `systemctl restart`, and `/health` probe only — provider-routing mutation requires operator authorisation and is out of scope for an automated agent task.

### 3.3 Cross-finding ordering

G06 (sync fs in stash) and G29 (plan-server serialize-blocks-reads) are latency amplifiers that can raise summarizer-timeout frequency. G07 does **not** depend on either. The round-parser and bounded fallback escape must hold under any summarizer failure regardless of cause (change 6 / cross-finding note in [./04-review-r1.md](./04-review-r1.md)). The cross-finding notes in [./03-plan-r2.md](./03-plan-r2.md) reflect this: G06 / G29 are informational, not blocking.

### 3.4 F13 coupling

The plan continues to rely on `pe.kind === "orphaned_tool_result"` at [src/agents/base.ts](../../../../src/agents/base.ts#L539-L559) firing when a downstream provider rejects a residual orphan from a prior broken run. Do not weaken `ORPHAN_RE` at [src/providers/error.ts](../../../../src/providers/error.ts#L79) without re-testing this path; the round-parser closes the producer side, the discriminant is the consumer side. Both must hold.
