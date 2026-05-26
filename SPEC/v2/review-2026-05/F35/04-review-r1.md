# F35 -- Review r1

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [_LOOP-CONVENTIONS.md](../_LOOP-CONVENTIONS.md)
- [F35-cli-channel-orphan.md](../F35-cli-channel-orphan.md)
- [01-analysis-r1.md](01-analysis-r1.md)
- [02-design-r1.md](02-design-r1.md)
- [03-plan-r1.md](03-plan-r1.md)

## Findings

### Analysis

No blocking issues. The orphan-status claims are accurate: `CLIChannel` appears only at its class definition and the barrel re-export, and `OneShotChannel` has the same definition-plus-barrel shape in [src/channels/cli.ts](src/channels/cli.ts#L7), [src/channels/oneshot.ts](src/channels/oneshot.ts#L6), and [src/channels/index.ts](src/channels/index.ts#L2-L3). Broader importer checks found no bare `channels` or `channels/index` importer under `src/` or `web/src/`.

The analysis also correctly corrects the loose issue-file wording about `bootstrap.ts`: live channel construction is in [src/server/server.ts](src/server/server.ts#L681) and [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L67), while `bootstrap.ts` has no channel construction references.

### Design

No blocking issues. The design includes the required multiple proposals and its recommended Proposal B is consistent with the project guideline to delete dead speculative surface instead of preserving unused compatibility or intent-only APIs. The package/build-surface risk assessment checks out: [tsup.config.ts](tsup.config.ts#L5-L11) builds `src/server/cli.ts` with `dts: false`, and [package.json](package.json#L1-L23) has no `exports` field exposing the channel barrel as a public package contract.

### Plan

No blocking issues. The edit steps are concrete and executable, and the validation set uses this repo's required commands: `npm run typecheck`, `npm run build`, focused Vitest runs, and full `npx vitest run`. The fallback to Proposal A is clearly separated from the recommended path and does not undermine the recommended implementation.

## Required changes

None.

## Strengths

- The writer identified the original F35 orphan and the adjacent same-class orphans without expanding into unrelated subsystems.
- Proposal B removes a small misleading API surface with very low runtime risk.
- The plan includes a useful negative bundle check for deleted symbols.

VERDICT: APPROVED