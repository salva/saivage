# Self-Check & Loop Detection

[`src/runtime/self-check.ts`](https://github.com/salva/saivage/blob/main/src/runtime/self-check.ts)

Long-running agent loops occasionally fall into degenerate patterns —
re-issuing the same tool call, looping over irrelevant searches, etc. The
self-check mechanism injects a **progress-assessment prompt** on a regular
cadence to break such patterns.

## Cadence

```ts
const DEFAULT_SELF_CHECK_FREQUENCY: Record<AgentRole, number> = {
  planner: 30,
  manager: 20,
  coder: 15,
  researcher: 15,
  data_agent: 15,
  reviewer: 15,
  inspector: 15,
  chat: 0, // disabled for chat
};
```

The unit is **tool-call rounds** — every call to the LLM that emits at
least one tool call counts. Roles with high turn count (Coder doing many
small edits) get checked more frequently.

## Prompt content

The injected prompt asks the agent to:

1. Restate the current goal.
2. Summarize what has been done since the last self-check.
3. Decide whether progress is being made; if not, propose a different
   approach or terminate the task with a failure reason.

The agent's normal response to this prompt is a short text message; the
loop then continues. Tool calls embedded in the self-check response are
honored normally.

## Stuck detection

Self-check is **not** an autonomous abort mechanism. The runtime watches
two harder signals to declare an agent stuck:

- **Compaction limit reached** (see [Compaction](./compaction)) → fail.
- **Supervisor verdict** of *stuck* repeated `consecutiveStuckVerdicts`
  times (see [Supervisor](./supervisor)) → abort and surface to the
  Planner.

## Disabling

Self-check is disabled for the Chat agent (it is interactive and short-
lived). For development you can disable per-role by setting the frequency
to `0` in a system-prompt override, but there is no public config knob —
the value lives in code.
