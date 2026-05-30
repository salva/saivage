# Inspector

[`src/agents/inspector.ts`](https://github.com/salva/saivage/blob/main/src/agents/inspector.ts)

The Inspector is a **one-shot deep-analysis agent**. It is invoked by the
Planner (for retrospectives) or by Chat (on user request) and produces an
`InspectionReport`.

## Purpose

Deep analysis of project state on demand.

## Lifetime

- Spawned via `run_inspector(request)` (a dispatch tool).
- Runs to completion, returns the report as the tool result, terminates.
- **Serialized:** only one Inspector runs at a time. Concurrent requests are
  FIFO-queued by the Dispatcher.

## Inputs

- Investigation request (from Planner or Chat)
- Scope/questions to answer

## Outputs

- Inspection reports (`.saivage/inspections/<report-id>.json`):

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

## Three storage tiers

| Path | Lifetime | Purpose |
|------|----------|---------|
| `.saivage/tmp/inspector-workspace/<report-id>/` | Ephemeral (gitignored) | Scratch space — partial outputs, exploratory scripts. |
| `.saivage/inspections/<report-id>.json` | Persistent | Final report. |
| `.saivage/tools/inspector/` | Persistent | Reusable analysis scripts the Inspector promotes from scratch. |

The Inspector is encouraged to write throwaway helpers in workspace, then
promote useful ones to `tools/inspector/` for reuse across investigations.

## Behaviors

- Analyzes project state: code quality, data status, test coverage, model
  performance, etc.
- Can create tools/scripts in ephemeral workspace during analysis, then
  promote useful ones to `.saivage/tools/inspector/`.
- Can read, execute, and modify any project file — same access as other
  agents. By convention, does not modify main project code unless the
  investigation requires it.
- Reports include metadata (timestamp, TTL) so the Planner can assess
  relevance.
- **Commits** reports and persistent tools via the MCP git tool.

## Tools advertised

Same toolset as the workers (filesystem, shell, git, web, memory, index) plus
`final` to commit the report. The Inspector typically reads more and writes
less than a Coder.

## Escalation

The Inspector cannot escalate. If it cannot answer the question it returns a
report whose `findings` document the failure mode. The caller (Planner / Chat)
decides what to do next.

## Trigger events

- Planner calls `run_inspector(request)` → Inspector spawned.
- Chat calls `run_inspector(request)` on user demand → Inspector queued behind
  any in-flight Planner request.
