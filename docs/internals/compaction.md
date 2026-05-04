# Compaction

[`src/runtime/compaction.ts`](https://github.com/salva/saivage/blob/main/src/runtime/compaction.ts)

LLM context windows are finite. **Compaction** replaces the agent's
in-flight conversation history with a structured summary, freeing context
for further work.

## When it triggers

After every tool round the agent's `BaseAgent.run` loop calls
`shouldCompact(messages, model, threshold)` which returns true when
estimated token usage exceeds `compaction_threshold_pct` (default **80 %**)
of the model's nominal window.

## Estimation

Saivage uses a coarse char→token heuristic (~4 chars per token, configured
in `compaction.ts`). It is intentionally conservative: false positives
trigger an unnecessary compaction; false negatives risk a hard provider
error.

## Procedure

1. The agent's loop pauses normal LLM dispatch.
2. A summarization request is issued to a (configurable) compactor model
   — by default the same model the agent uses.
3. The compactor returns a structured summary covering goals, decisions,
   open questions, and unfinished work.
4. The agent's `messages` array is replaced with: `[system prompt,
   summary system message, last user/tool input]`.
5. The agent's `compactionCount` is incremented.
6. The conversation loop resumes.

## Hard limit

`max_compactions` (default 3) caps how many times an agent may compact.
After that, the agent fails:

- Workers → return a `TaskReport` with `failure_reason: "context exhausted"`.
- Manager → escalates to the Planner with `result: "failed"`.
- Planner → returns `RunPlanResult` with `kind: "failure"` (rare; the
  Planner should usually be able to compact and continue).

## What survives compaction

- The agent's **system prompt** (always re-applied).
- The **plan MCP service** (Planner). After compaction the Planner
  re-fetches `plan_get()` and `plan_get_history()`.
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
