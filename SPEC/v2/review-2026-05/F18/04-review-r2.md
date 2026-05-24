# F18 Review r2

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F18-system-prompt-bloat.md](SPEC/v2/review-2026-05/F18-system-prompt-bloat.md)
- [SPEC/v2/review-2026-05/F18/04-review-r1.md](SPEC/v2/review-2026-05/F18/04-review-r1.md)
- [SPEC/v2/review-2026-05/F18/01-analysis-r1.md](SPEC/v2/review-2026-05/F18/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F18/02-design-r2.md](SPEC/v2/review-2026-05/F18/02-design-r2.md)
- [SPEC/v2/review-2026-05/F18/03-plan-r2.md](SPEC/v2/review-2026-05/F18/03-plan-r2.md)
- Spot-checked: [src/agents/chat.ts](src/agents/chat.ts), [src/chat/slashCommands.ts](src/chat/slashCommands.ts), [deploy/Makefile](deploy/Makefile), [deploy/scripts/provision.sh](deploy/scripts/provision.sh), and [tsup.config.ts](tsup.config.ts).

## Findings

### Analysis

No blocking issues. The r1 analysis remains accurate and sufficient for implementation. It correctly frames F18 as a prompt-architecture issue with related drift pressure from F02, F09, F30, F31, and F33, while preserving the synchronous constructor and bundled-deployment constraints.

### Design

Approved. The r2 design resolves the r1 slash-command scoping blocker by narrowing F18's new `LOCAL_CHAT_COMMANDS` source of truth to the local Chat command family only. This matches the current code: [src/agents/chat.ts](src/agents/chat.ts#L300-L329) delegates `/skills`, `/memories`, `/remember`, and `/forget` to `parseSlashCommand` / `runSlashCommand`, while [src/agents/chat.ts](src/agents/chat.ts#L336-L358) handles the local command switch. The current prompt list at [src/agents/chat.ts](src/agents/chat.ts#L99-L110) also lists only the local command family, so replacing that prompt text with `{{slash_commands_table}}` is content-preserving and does not pull memory/skills behavior into the wrong module.

The design also correctly leaves the remaining duplication between the local switch and `cmdHelp` to F30. That is a clean boundary: F18 removes the prompt-text copy, and F30 can later deduplicate dispatch/help without touching the out-of-scope skills/memory subsystem.

### Plan

Approved. The r2 plan is executable and addresses both r1 required changes:

1. Step 2 and Step 7 no longer require every slash-command metadata entry to map to a local `tryHandleCommand` case. The proposed tests now validate the prompt substitution and local command metadata only, which matches F18's scope.
2. The smoke validation now names the actual deployed unit, `saivage.service`, consistent with [deploy/scripts/provision.sh](deploy/scripts/provision.sh#L127-L147). The optional SSH and classic-LXC commands are consistent with workspace operations guidance.

The build plan is also viable: [tsup.config.ts](tsup.config.ts#L1-L18) already imports `cp` and `mkdir`, uses `clean: true`, and copies non-TS assets through `onSuccess`; adding `prompts/` is same-shape rather than a new deployment mechanism.

## Required changes

None.

## Strengths

- The recommended Proposal B removes the embedded TS prompt constants without transitional fallbacks, matching the no-backward-compatibility rule.
- The prompt loader remains deliberately small: literal includes plus one substitution map entry, with tests guarding unrendered markers.
- The r2 scope is disciplined around the skills/memory ownership boundary while still improving F18's architectural target.

VERDICT: APPROVED