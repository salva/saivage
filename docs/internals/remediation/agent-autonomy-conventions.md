# Agent Autonomy, Conventions, And Nudges

## Problem

Saivage's central product idea is that agents are autonomous collaborators. They
should decide what to do from their role, objective, context, and conventions.
The architecture review identified places where runtime hard enforcement could
make behavior more deterministic, but too much enforcement would undermine the
model: agents would become a thin UI over a scripted workflow.

The actual problem is not broad tool access by itself. The problem is that the
runtime has too few structured ways to notice when an agent drifted from its
contract and guide it back.

Examples:

- A Planner ends with text instead of using plan tools.
- A Manager returns a summary without credible task/report evidence.
- A Worker claims success without running tools or producing a report.
- A Reviewer gives generic approval without inspecting stage artifacts.
- A role writes outside its convention because the prompt was ignored.

## Goal

Keep simple role permissions and prompt-led behavior, while adding deterministic
observation and repair loops.

The runtime should answer these questions after every relevant agent turn:

- Did the agent use the tools expected for this kind of turn?
- Did it produce the artifact it was asked to produce?
- Does the artifact validate against the schema?
- Does the artifact cite enough evidence to be credible?
- Did it violate a convention that should trigger a corrective nudge?
- Is the violation severe enough to stop, or should the agent be allowed to
  repair itself?

## Non-Goals

- Do not replace agent judgement with a scripted stage executor.
- Do not create a large permission matrix for every possible role/action pair.
- Do not parse shell commands to infer all possible mutations.
- Do not make every convention violation fatal.

## Design

Start from the mechanisms that already exist:

- `validateFinalResponse()` already detects weak terminal responses and injects a
  repair prompt. `BaseAgent` increments `invalidFinalResponseCount` and terminates
  after 3 consecutive failures. This is the existing nudge loop — the new design
  should evolve it, not replace it.
- `detectTerminalToolCall()` already treats `plan_done` as terminal tool
  evidence. Submission tools should use this same pattern.
- `decidePathMutation()` already blocks write-path mutations that violate role
  territory in `write_file`, `download_file`, `download_with_fallbacks`,
  `git_commit`, and shell output paths. Path enforcement is a hard safety
  boundary, not a behavioral nudge.

The compliance design should evolve these mechanisms, not create a parallel
policy framework.

Note on existing nudge loop behavior: `invalidFinalResponseCount` resets to 0
whenever the agent makes any tool call, meaning a single trivial tool call can
reset the counter. The new compliance layer should address this — evidence of
meaningful tool use, not any tool use, should clear the nudge counter.

### Coarse Tool Access

Keep the existing simple tool-filter model:

- Planner sees planning and read tools.
- Worker-like roles see broad execution tools.
- Reviewer-like roles see read, shell, and stash tools.
- Chat sees read, web, stash, and note tools.
- Librarian sees RAG and knowledge curation tools.

Note: Reviewer, Inspector, and Critic currently have `run_command` (shell access)
through their tool filter. This is intentional — Reviewer and Inspector need shell
to inspect build outputs and run tests — but it means the convention system must
rely on path enforcement and behavioral nudges rather than tool denial to keep
these roles in their territory.

This is an affordance model. It reduces accidental noise in the prompt, but it is
not the main behavioral guarantee.

### Conventions As Observable Contracts

Role conventions should be represented as data and repeated in prompts, but the
runtime should treat them as observable contracts rather than mostly comments.

For each convention, define:

- `id`: stable identifier, such as `coder-writes-source`.
- `severity`: `info`, `warning`, or `error`.
- `detect`: deterministic check over tool calls, paths, and submitted artifacts.
- `nudge`: prompt text explaining what drift occurred and how to repair it.
- `fatal_after`: optional number of failed repair attempts.

Examples:

- Coder writing under `research/` is usually a warning and should get a nudge.
- Researcher modifying source code is usually a warning and should get a nudge.
- Direct writes to secret-bearing files are fatal.
- Manager returning a summary without a Reviewer report is a warning on first
  occurrence and can become fatal after repeated refusal.

### Minimal Compliance Result

Every detector should return a small result or `null`:

```ts
interface ComplianceViolation {
  conventionId: string;
  message: string;
  repairPrompt: string;
  fatal: boolean;
}
```

Log violations through the existing diagnostics path. Add a dashboard projection
later only if operators need it. Do not introduce a registry, event bus, or
check-family framework for the initial implementation.

### Nudge Loop

For repairable drift:

1. Runtime records the violation through existing diagnostics/logging.
2. Runtime appends a short system nudge to the conversation.
3. Agent gets another turn with the same objective and explicit repair request.
4. Runtime re-checks the next turn.
5. Runtime escalates only after one simple retry limit is exceeded or when state
   safety is at risk.

The existing `validateFinalResponse` mechanism already implements this pattern
with `MAX_INVALID_FINAL_RESPONSES = 3`. The new compliance layer should extend
this mechanism rather than replace it. The current counter resets to 0 on any tool
call; the new design should require evidence of meaningful tool use to clear the
counter.

The active repair prompt must survive compaction. The planner pre-compaction hook
(`runPlannerCompactionHook`) already preserves important context across compaction
by giving the agent a 5-turn window to create memories. The same pattern should be
used for compliance nudges: store the pending repair prompt in `ConversationState`
and reinject it after compaction, similar to how survivor blocks are reinjected.

The nudge should not be generic. It should name the exact missing contract and
the next expected action.

Example:

```text
SYSTEM COMPLIANCE NUDGE: You returned a StageSummary, but no Reviewer task
report exists for this stage. Your Manager convention requires review before
stage completion. Dispatch run_reviewer for stage <id>, inspect its report, then
submit a revised StageSummary.
```

### Hard Refusal Cases

Some cases are not good candidates for nudging:

- Secret exposure or attempts to read known secret-bearing files.
- Writes outside the project root.
- Corrupt persisted JSON or schema-invalid state transitions.
- Runtime lock violations.
- Operator-only actions invoked from an agent context.
- Dangerous process lifecycle operations outside an explicitly granted operator
  path.

These should remain hard runtime boundaries.

### Evidence Checks

Managers and workers should not merely claim completion. The runtime should
check for evidence that matches the role contract.

Examples:

- Worker success requires a submitted `TaskReport` and at least one real tool use
  unless the task explicitly says no tool use is needed.
- Coder success should usually include changed files, tests run, or a clear
  explanation that no code change was necessary.
- Manager success should reference existing task reports and review results.
- Planner `plan_done` should reference completed stages and objectives.

These are not all hard requirements. They are evidence heuristics that trigger
nudges when weak.

## Implementation Shape

Add a small compliance module, not a framework:

- `runtime/compliance.ts`: small check functions returning
  `ComplianceViolation | null`.
- Optional tiny helpers for rendering repair prompts if repeated strings become
  noisy.

Lifecycle hooks:

- After every tool-call batch.
- Before accepting a terminal worker response.
- Before accepting a Manager `StageSummary`.
- Before accepting Planner `plan_done`.

## Validation

- Stub-model tests where an agent omits required evidence and receives a nudge.
- Tests where repair on the next turn succeeds.
- Tests where repeated non-compliance becomes failure.
- Tests where fatal cases refuse immediately.

## Tradeoff

This preserves autonomy but increases runtime checks. Keep the checks small,
explainable, and tied to documented conventions. If a check requires complex
business logic, it probably belongs in a typed artifact tool or Reviewer task
rather than in generic compliance code.
