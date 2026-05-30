# Inspector

[`src/agents/inspector.ts`](https://github.com/salva/saivage/blob/main/src/agents/inspector.ts),
[`prompts/inspector.md`](https://github.com/salva/saivage/blob/main/prompts/inspector.md)

The Inspector is a **one-shot deep-analysis agent**. It is invoked by the
Planner through `run_inspector()` or directly by the CLI `inspect` action and
produces an `InspectionReport`.

## Purpose

Deep analysis of project state on demand.

## Lifetime

- Spawned via `run_inspector(request)` when the Planner dispatches it, or by
  `inspectAction()` for CLI inspection runs.
- Runs to completion, returns the report as the tool result, terminates.
- The current Dispatcher does not implement a FIFO Inspector queue; Inspector
  is a non-worker dispatch role and is not part of the worker duplicate-dispatch
  gate.

## Inputs

- Investigation request (from Planner dispatch or CLI inspect action)
- Scope/questions to answer

## Outputs

- Inspection reports (`.saivage/inspections/<report-id>.json`):

  ```ts
  interface InspectionReport {
    id: string;
    requested_by: "planner" | "chat";
    request: InspectionRequest;
    findings: string;            // structured Markdown
    recommendations: string[];
    data: Record<string, unknown>;
    artifacts: string[];
    created_at: string;
    expires_at: string | null;   // null = permanent relevance
    duration_ms: number;
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
- Investigates with read-only filesystem/git tools plus shell. All file output
  flows through `run_command` and is constrained by the Inspector write
  territory; it should not modify source code.
- Reports include metadata (timestamp, TTL) so the Planner can assess
  relevance.
- **Commits** reports and persistent tools via the MCP git tool.

## Tools advertised

Inspector tools are filtered by the roster's `inspector` tool filter:
read-only filesystem and git tools, `run_command`, web search/fetch tools,
`list_skills`, `read_skill`, and `read_stash`. It has no dispatch tools and no
`write_file`; reports, reusable tools, and commits are created through shell
commands inside the Inspector write territory.

## Escalation

The Inspector cannot escalate. If it cannot answer the question it returns a
report whose `findings` document the failure mode. The caller (Planner / Chat)
decides what to do next.

## Trigger events

- Planner calls `run_inspector(request)` → Inspector spawned.
- CLI `inspect <project-path> <scope>` constructs an `InspectorAgent` directly.
