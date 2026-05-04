# Inspector

[`src/agents/inspector.ts`](https://github.com/salva/saivage/blob/main/src/agents/inspector.ts)
· spec [§2.5](https://github.com/salva/saivage/blob/main/SPEC/v2/00-AGENT-SYSTEM.md#25-inspector)

The Inspector is a **one-shot deep-analysis agent**. It is invoked by the
Planner (for retrospectives) or by Chat (on user request) and produces an
`InspectionReport`.

## Lifetime

- Spawned via `run_inspector(request)` (a dispatch tool).
- Runs to completion, returns the report as the tool result, terminates.
- **Serialized**: only one Inspector runs at a time. Concurrent requests
  are FIFO-queued by the Dispatcher.

## Three storage tiers

| Path | Lifetime | Purpose |
|------|----------|---------|
| `.saivage/tmp/inspector-workspace/<report-id>/` | Ephemeral (gitignored) | Scratch space — partial outputs, exploratory scripts. |
| `.saivage/inspections/<report-id>.json` | Persistent | Final report. |
| `.saivage/tools/inspector/` | Persistent | Reusable analysis scripts the Inspector promotes from scratch. |

The Inspector is encouraged to write throwaway helpers in workspace, then
promote useful ones to `tools/inspector/` for reuse across investigations.

## InspectionReport

```ts
interface InspectionReport {
  id: string;
  requested_by: "planner" | "chat";
  scope: string;
  findings: string;            // structured Markdown
  recommendations: string[];
  created_at: string;
  expires_at?: string | null;  // null = permanent relevance
  metadata?: Record<string, unknown>;
}
```

The Planner uses `expires_at` to assess whether a previous report is still
relevant before issuing a new one.

## Tools advertised

Same toolset as the workers (filesystem, shell, git, web, memory, index)
plus `final` to commit the report. The Inspector typically reads more and
writes less than a Coder.

## Escalation

The Inspector cannot escalate. If it cannot answer the question it returns
a report whose `findings` document the failure mode. The caller (Planner /
Chat) decides what to do next.
