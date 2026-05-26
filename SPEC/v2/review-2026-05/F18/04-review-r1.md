# F18 Review r1

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F18-system-prompt-bloat.md](SPEC/v2/review-2026-05/F18-system-prompt-bloat.md)
- [SPEC/v2/review-2026-05/F18/01-analysis-r1.md](SPEC/v2/review-2026-05/F18/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F18/02-design-r1.md](SPEC/v2/review-2026-05/F18/02-design-r1.md)
- [SPEC/v2/review-2026-05/F18/03-plan-r1.md](SPEC/v2/review-2026-05/F18/03-plan-r1.md)
- Spot-checked: [src/agents/base.ts](src/agents/base.ts), [src/agents/coder.ts](src/agents/coder.ts), [src/agents/researcher.ts](src/agents/researcher.ts), [src/agents/data-agent.ts](src/agents/data-agent.ts), [src/agents/reviewer.ts](src/agents/reviewer.ts), [src/agents/inspector.ts](src/agents/inspector.ts), [src/agents/chat.ts](src/agents/chat.ts), [src/agents/planner.ts](src/agents/planner.ts), [src/agents/manager.ts](src/agents/manager.ts), [src/agents/designer.ts](src/agents/designer.ts), [src/agents/conventions.ts](src/agents/conventions.ts), [tsup.config.ts](tsup.config.ts), and [src/chat/slashCommands.ts](src/chat/slashCommands.ts).

## Findings

### Analysis

No blocking issues. The analysis correctly identifies the embedded prompt constants, the `BaseAgentConfig.systemPrompt` documentation mismatch, the current `BaseAgent` prompt assembly, and the existing `tsup` asset-copy precedent. The key constraints are also right: no fallback to old TS prompt constants, synchronous prompt availability for constructors, and bundled prompt assets.

### Design

Proposal B is the right architectural direction: Markdown prompt files plus a tiny include/substitution loader match the existing asset-copy pattern and remove the worst code/prompt coupling. The rejected full template-engine proposal is correctly ruled out as over-engineering.

The one design gap is in the chat command source of truth. The design says `slash_commands_table` should come from a single declarative command array, but the current Chat path has two command families: local Chat commands handled by the switch in [src/agents/chat.ts](src/agents/chat.ts#L331-L360), and knowledge/memory commands delegated to `parseSlashCommand`/`runSlashCommand` before that switch in [src/agents/chat.ts](src/agents/chat.ts#L300-L329). The revised design needs to preserve that split or explicitly unify both command families without moving memory/skills behavior into the wrong module.

### Plan

The implementation plan is close, but two executability problems block approval.

First, Step 2's proposed `CHAT_COMMANDS` array includes only `/help`, `/status`, `/plan`, `/history`, `/replan`, `/restart-planner`, `/note`, `/note!`, and `/notep` in [SPEC/v2/review-2026-05/F18/03-plan-r1.md](SPEC/v2/review-2026-05/F18/03-plan-r1.md#L37-L52). The current help output also exposes `/skills list`, `/skills show`, `/memories list`, `/memories show`, `/memories search`, `/remember`, and `/forget` in [src/agents/chat.ts](src/agents/chat.ts#L379-L385), and those commands are real: [src/chat/slashCommands.ts](src/chat/slashCommands.ts#L8-L16) documents them, [src/chat/slashCommands.ts](src/chat/slashCommands.ts#L37-L80) parses them, and [src/chat/slashCommands.ts](src/chat/slashCommands.ts#L90-L118) routes them through MCP or Planner notification. As written, replacing `cmdHelp` with the proposed array would either drop user-visible commands from help/prompt text or force memory/skills commands into the local Chat switch. The proposed `chat-commands.test.ts` assertion that every `CHAT_COMMANDS` entry has a `tryHandleCommand` case in [SPEC/v2/review-2026-05/F18/03-plan-r1.md](SPEC/v2/review-2026-05/F18/03-plan-r1.md#L155-L157) also encodes the wrong architecture for the parse-routed command family.

Second, the live smoke-validation step says to restart `saivage-v3.service` in [SPEC/v2/review-2026-05/F18/03-plan-r1.md](SPEC/v2/review-2026-05/F18/03-plan-r1.md#L170-L178). The workspace's `saivage-v3` container service is `saivage.service`; `saivage-v3` is the container name, not the systemd unit. This makes the validation recipe fail at the operational step and should be corrected before an engineer follows the plan.

## Required changes

1. Revise the design/plan for slash-command metadata so it includes or composes both command families: the local Chat commands and the existing knowledge/memory commands from `src/chat/slashCommands.ts`. Preserve the current `parseSlashCommand`/`runSlashCommand` routing for memory and skills commands unless the plan explicitly replaces that module with an equivalent single source of truth. Update the proposed tests so they validate both switch-handled commands and parse-routed commands instead of requiring every command to have a local switch case.

2. Fix the smoke validation instructions to use the actual `saivage-v3` container service name, `saivage.service`, or phrase the step as a container/service restart following the workspace LXC conventions without naming a nonexistent unit.

## Strengths

- The proposal honors the no-backward-compatibility rule by deleting TS prompt constants instead of adding fallback loaders.
- The two-marker loader is appropriately small and synchronous, and its `tsup` asset-copy deployment story matches the existing `skills/builtin` precedent.
- The plan keeps ordinary agent unit tests on stub prompts while adding a focused prompt-loader integration guard, which is the right test split.

VERDICT: CHANGES_REQUESTED