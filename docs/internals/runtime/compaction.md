# Compaction

[`src/runtime/compaction.ts`](https://github.com/salva/saivage/blob/main/src/runtime/compaction.ts)

LLM context windows are finite. **Compaction** replaces the agent's
in-flight conversation history with a structured summary, freeing context
for further work.

## When it triggers

Before each LLM call the agent's `BaseAgent.runLoop` checks
`shouldCompact(runningTokens, config)`. It returns true when the dynamic
message-token estimate plus the static system/tool-token estimate exceeds
`compaction_threshold_pct` (default **80 %**) of the model's nominal
window.

## Estimation

The compaction trigger uses `ModelRouter.countTokens(...)`. Providers can
implement exact-ish counting; the built-in token counter uses `js-tiktoken`
for text, thinking, tool-use, tool-result, image, system-prompt, and tool
schema blocks. Provider-reported input token counts can tighten the running
estimate when they exceed the local estimate by more than 10%.

## Procedure

1. The agent's loop pauses normal LLM dispatch.
2. A summarization request is issued to `config.summaryModelSpec`, defaulting to the same model spec the agent uses.
3. The compactor returns a structured summary covering goals, decisions,
   open questions, and unfinished work.
4. On success, `compactConversation` returns one user-role summary message; `BaseAgent` supplies the system prompt separately on the next `router.chat` call.
5. `BaseAgent.compactWithReinjection()` appends any survivor knowledge block returned by the knowledge loader, then calls `replaceMessages` and resets input channels.
6. `compactionCount` is incremented on successful summarization. If summarization fails, Saivage falls back to round-parser truncation, increments `summarizerFallbacks` / `consecutiveFallbacks`, and keeps the most recent valid atomic rounds that fit under the threshold minus a 1024-token safety margin.
7. The conversation loop resumes.

## Hard limit

`max_compactions` (default 3) caps successful compactions. The same stop
check also fails the agent after 3 consecutive summarizer fallbacks or one
oversized atomic fallback round. After that, the agent fails:

- Workers → return an `AgentResult` failure with a partial failed
  `TaskReport`.
- Manager → returns an `AgentResult` failure with a partial `StageSummary`
  whose `result` is `"failed"`.
- Planner → returns an `AgentResult` with `kind: "failure"`.

## What survives compaction

- The agent's **system prompt** (always re-applied).
- The **plan MCP service** (Planner). After compaction the Planner
  re-fetches `plan_get()` and `plan_get_history()`.
- Project-scoped active skills and memories with `survive_compaction: true`
  are re-injected as one user-role `--- SURVIVING KNOWLEDGE ---` block when
  they pass the survivor summary ceiling.
- Files on disk — the post-compaction agent re-reads them on demand.

What is lost:

- Specific working memory (rationale that wasn't surfaced into commits or
  reports).
- Prior tool-call results and intermediate responses.

The summary is constructed to capture the irreplaceable parts: what was
tried, what failed, what to do next.

## Tuning

Per-agent overrides live in `ProjectConfig.agents.<role>`:

```jsonc
"agents": {
  "manager": { "compaction_threshold_pct": 70, "max_compactions": 5 }
}
```

Lower the threshold for verbose roles (they generate large tool-result
blobs); raise it on models with very large context windows.
