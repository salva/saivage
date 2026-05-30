# Self-Check & Loop Detection

[`src/runtime/self-check.ts`](https://github.com/salva/saivage/blob/main/src/runtime/self-check.ts)

Long-running agent loops occasionally fall into degenerate patterns —
re-issuing the same tool call, looping over irrelevant searches, etc.
`src/runtime/self-check.ts` defines the counter and prompt helper for a
progress-assessment nudge, but the current `BaseAgent` loop does not wire
that helper into live conversations.

## Cadence

```ts
const DEFAULT_SELF_CHECK_FREQUENCY: Record<AgentRole, number> = {
  planner: 30,
  manager: 20,
  coder: 15,
  researcher: 15,
  data_agent: 15,
  reviewer: 15,
  designer: 15,
  critic: 15,
  inspector: 15,
  chat: 0, // disabled for chat
  librarian: 20,
};
```

The unit is **tool-call rounds** — every call to the LLM that emits at
least one tool call counts. `DEFAULT_SELF_CHECK_FREQUENCY` is derived from
`ROSTER.selfCheckFrequency` rather than maintained as a separate literal.

## Prompt content

`selfCheckMessage(frequency)` returns a prompt that asks the agent to:

1. Restate the current goal.
2. Summarize what has been done since the last self-check.
3. Decide whether progress is being made; if not, propose a different
   approach or terminate the task with a failure reason.

No production caller currently injects that prompt. If the helper is wired
in later, the agent response should be processed by the normal conversation
loop and tool calls in the response should be honored normally.

## Stuck detection

Self-check is **not** an autonomous abort mechanism, and today it is not a
live mechanism at all. The runtime watches harder signals to declare or
handle stuck work:

- **Compaction limit reached**, **fallback exhaustion**, or an **oversized
  atomic tool round** (see [Compaction](./compaction)) → fail the agent.
- **Supervisor verdict** of *stuck* repeated `consecutiveStuckVerdicts`
  times (see [Supervisor](./supervisor)) → cancel the selected abortable
  active agent.
- **Planner text-only loops** are nudged up to 15 times by `PlannerAgent`
  before the recovery loop restarts the Planner.

## Disabling

The roster sets Chat's frequency to `0`. `createSelfCheckState(role,
configFrequency)` accepts an optional override for callers/tests, but
there is no public runtime configuration knob and no live caller in the
current `BaseAgent` loop.
