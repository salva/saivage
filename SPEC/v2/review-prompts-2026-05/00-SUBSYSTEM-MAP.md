# Prompts Review — Subsystem Map

## Scope

The prompt subsystem at [saivage/prompts/](prompts/) and its loader at
[saivage/src/agents/prompts.ts](src/agents/prompts.ts). One review issue per
prompt file (11 total).

Out of scope: agent runtime code, MCP services, web UI, anything outside
`prompts/` except where a prompt asserts a fact that must match the runtime
contract (the writer subagent must check those assertions against the cited
runtime files but must not propose runtime code changes — only prompt edits).

## Files in scope

| Id   | File                                                                    | Lines | Role agent                                    | Runtime tools available (filter)         |
|------|-------------------------------------------------------------------------|-------|-----------------------------------------------|------------------------------------------|
| F01  | [prompts/planner.md](prompts/planner.md)                                | 140   | Planner ([planner.ts](src/agents/planner.ts)) | `planner` (Plan MCP + read-only fs+git)  |
| F02  | [prompts/manager.md](prompts/manager.md)                                | 253   | Manager ([manager.ts](src/agents/manager.ts)) | `worker` (Plan MCP + run_* dispatchers)  |
| F03  | [prompts/coder.md](prompts/coder.md)                                    | 119   | Coder ([coder.ts](src/agents/coder.ts))       | `worker` (fs+git+test+knowledge)         |
| F04  | [prompts/researcher.md](prompts/researcher.md)                          | 118   | Researcher ([researcher.ts](src/agents/researcher.ts)) | `worker` (web fetch + fs+knowledge) |
| F05  | [prompts/data-agent.md](prompts/data-agent.md)                          |  53   | Data Agent ([dataAgent.ts](src/agents/dataAgent.ts)) | `worker` (web + downloads + fs)     |
| F06  | [prompts/reviewer.md](prompts/reviewer.md)                              |  60   | Reviewer ([reviewer.ts](src/agents/reviewer.ts)) | `reviewer` (read-only fs + knowledge) |
| F07  | [prompts/critic.md](prompts/critic.md)                                  |  66   | Critic ([critic.ts](src/agents/critic.ts))    | `reviewer` (read-only fs + knowledge)    |
| F08  | [prompts/designer.md](prompts/designer.md)                              |  64   | Designer ([designer.ts](src/agents/designer.ts)) | `worker` (fs+research+knowledge)      |
| F09  | [prompts/inspector.md](prompts/inspector.md)                            | 113   | Inspector ([inspector.ts](src/agents/inspector.ts)) | `inspector` (read-only fs + tools) |
| F10  | [prompts/chat.md](prompts/chat.md)                                      |  86   | Chat ([chat.ts](src/agents/chat.ts))          | `chat` (notes + run_inspector + WS)      |
| F11  | [prompts/shared/execution-style.md](prompts/shared/execution-style.md)  |   7   | (shared — included by every role)             | n/a (style include)                      |

Total: 1079 lines across 11 files.

## Loader contract

[src/agents/prompts.ts](src/agents/prompts.ts) renders each prompt with two
substitution passes:

1. `{{> path }}` — include another file under `prompts/` (one level deep, no
   recursion is supported in code).
2. `{{ var }}` — interpolate from
   [substitutions()](src/agents/prompts.ts#L52):
   - `roster_summary` — bullet list of every role from
     [roster.ts](src/agents/roster.ts#L420) (`renderRosterSummary`), with the
     focal role marked `(you)`.
   - `slash_commands_table` — table from
     [localCommandRegistry.ts](src/chat/localCommandRegistry.ts) (only used by
     `chat.md`).

Anything else inside `{{ }}` throws at startup.

## Runtime contract surfaces a prompt may assert

A prompt is "correct" only if every concrete claim about runtime behaviour
matches one of these sources of truth:

- **Tool names & dispatch** — [roster.ts](src/agents/roster.ts) (`dispatchTool`,
  `dispatchableBy`, `toolFilter`).
- **Return shapes** — `TaskReport`, `StageSummary`, `InspectionReport`,
  `TaskList`, `PlanDocument` in [src/types.ts](src/types.ts).
- **MCP tool surface per role** — [src/mcp/](src/mcp/) handlers + the
  `toolFilter` in `roster.ts`.
- **Worker initial-message** — `workerInit` in [roster.ts](src/agents/roster.ts)
  for that role.
- **Knowledge service permissions** —
  [src/knowledge/permissions.ts](src/knowledge/permissions.ts).
- **Conventions / territory** — `convention` in `roster.ts`.

A prompt MAY paraphrase those surfaces; it MUST NOT contradict them.

## Cross-cutting structure shared across all prompts

Every role prompt follows roughly this shape (in this order):

1. `# <Role> — System Prompt`
2. `## The Saivage System` — copy of the roster summary block (currently
   hand-written in each prompt, NOT generated via `{{ roster_summary }}` —
   only the manager and a few others use the helper; this inconsistency is
   itself an axis to evaluate).
3. `## Communication Protocol`
4. `## Persistence & State`
5. `## Your Role`
6. `## Tools Available`
7. Role-specific sections (Execution Model, Conventions, etc.).
8. `{{> shared/execution-style }}` — visible-execution-style include (most
   prompts; verify each one).

`shared/execution-style.md` itself is reviewed as F11.

## Project-wide review axes (apply to every issue)

From the user's request and project guidelines:

1. **Correctness vs runtime** — every concrete tool name, return-shape field,
   dispatch direction, file path, and territory rule must match the runtime
   contract surfaces listed above. Cite the source file when challenging.
2. **Conciseness vs specificity** — the prompt must be short enough that the
   agent reads and retains it, but specific enough that the agent does the
   right thing without trial-and-error. Flag walls of text, repetition,
   restated obvious things, and 3-paragraph explanations of one rule. Flag
   missing rules that runtime relies on the agent following.
3. **No over-featurism** — drop sections that describe capabilities the agent
   does not actually have or scenarios that never occur. Drop tutorials for
   tools the agent already knows how to use.
4. **No dead instructions** — references to deprecated/removed runtime
   behaviour, migration scaffolding, v1-vs-v2 disclaimers, "in the old
   system…" framing — all must go (workspace rule: no backward compatibility).
5. **No duplication with `shared/execution-style.md`** — rules that belong in
   the shared include must not be repeated per role.
6. **Cross-prompt voice & terminology consistency** — same noun/verb for the
   same concept across all role prompts (e.g. "follow-up dispatch" vs
   "follow-up turn" vs "subsequent dispatch"; "task" vs "assignment"; "stage
   summary" capitalization). Flag drift.
7. **Honour runtime, do not over-specify what runtime enforces** — if the
   schema rejects a malformed `TaskReport`, the prompt does not need a
   3-paragraph warning about field types. If the supervisor auto-aborts on
   convention violation, the prompt does not need to teach the agent to police
   itself.

## Out-of-scope axes (do not propose changes)

- Adding new agent roles, runtime tools, or MCP services.
- Changing return shapes or dispatch rules.
- Touching `src/agents/*.ts`, `src/mcp/*`, `web/`, tests, or build config.

The output of this review is **edits to prompt files only**, plus possibly
extending the loader's substitution set if a proposal needs a new
`{{ variable }}` for de-duplication (e.g. a `{{ task_report_schema }}` block).
Loader changes require a separate justification in the design doc.
