# Prompts Review — Issue Index

Output dir: [saivage/SPEC/v2/review-prompts-2026-05/](.)
Subsystem map: [00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md)

| Id   | Prompt                                                  | Severity | Transversality |
|------|---------------------------------------------------------|----------|----------------|
| F01  | [planner.md](F01-planner-prompt.md)                     | high     | local          |
| F02  | [manager.md](F02-manager-prompt.md)                     | high     | local          |
| F03  | [coder.md](F03-coder-prompt.md)                         | high     | local          |
| F04  | [researcher.md](F04-researcher-prompt.md)               | medium   | possibly cross |
| F05  | [data-agent.md](F05-data-agent-prompt.md)               | medium   | local          |
| F06  | [reviewer.md](F06-reviewer-prompt.md)                   | medium-high | local + F07/F11 |
| F07  | [critic.md](F07-critic-prompt.md)                       | medium   | cross (F08)    |
| F08  | [designer.md](F08-designer-prompt.md)                   | medium   | cross (F07)    |
| F09  | [inspector.md](F09-inspector-prompt.md)                 | medium   | local          |
| F10  | [chat.md](F10-chat-prompt.md)                           | high     | local          |
| F11  | [shared/execution-style.md](F11-shared-execution-style.md) | medium | highly cross   |

## Dance plan

- Models: writer = Claude Opus 4.7 (copilot), reviewer = GPT-5 (copilot).
- Iteration cap per document: unlimited until reviewer APPROVES, with
  deadlock-detection escalation (two consecutive reviewer rounds with the same
  objections → escalate to operator).
- Pauses: none through Phase E; stop before Phase G (implementation).
- Parallelism: up to 3 issues run their analysis/design/plan loop concurrently.
- Sequencing: F11 (shared) ordering matters — its proposal may absorb
  duplication from per-role prompts. Schedule F11 first; per-role prompts may
  reference its outcome.

## Output structure per issue

```
FNN-<slug>/
  00-issue.md                  -> copy/link to the inventory entry
  01-analysis-rN.md            -> writer
  01-analysis-review-rN.md     -> reviewer
  02-design-rN.md              -> writer (≥2 proposals: focused + level-up)
  02-design-review-rN.md       -> reviewer
  03-plan-rN.md                -> writer
  03-plan-review-rN.md         -> reviewer
  APPROVED.md                  -> reviewer final OK
```
