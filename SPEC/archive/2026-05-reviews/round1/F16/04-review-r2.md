# F16 - Review (r2)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F16/01-analysis-r1.md](SPEC/v2/review-2026-05/F16/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F16/02-design-r2.md](SPEC/v2/review-2026-05/F16/02-design-r2.md)
- [SPEC/v2/review-2026-05/F16/03-plan-r2.md](SPEC/v2/review-2026-05/F16/03-plan-r2.md)

## Findings

### Analysis

The r1 analysis remains authoritative and does not need revision. The source spot-check still confirms its core claim: inbound messages check the user namespace through `ctx.from?.id` while session state is keyed by `ctx.chat.id` in [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L113-L124), and the unsafe boot path still creates sessions from `allowedUserIds` in [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L134-L139). That preserves the functional problem the design and plan are addressing.

### Design

The r2 design resolves the r1 scope inconsistency. Proposal B now explicitly leaves [src/config.ts](src/config.ts#L98-L103) unchanged, keeps [src/store/documents.ts](src/store/documents.ts) as a generic document CRUD layer, and places the new absolute document path on [src/store/project.ts](src/store/project.ts#L29-L47) / [src/store/project.ts](src/store/project.ts#L71-L88). This matches the actual code ownership boundaries.

The recommendation of Proposal B remains acceptable. It removes the old implicit notify-on-allow-list behavior without a compatibility shim, separates inbound auth from outbound destinations, and keeps the new persistence surface small enough to satisfy the no-over-engineering guideline.

### Plan

The r2 plan resolves the two r1 executability gaps. Startup now uses `readDocOrNull(..., TelegramSubscriptionsSchema) ?? { chatIds: [] }`, which matches the missing-file behavior implemented in [src/store/documents.ts](src/store/documents.ts#L29-L36) while preserving loud failures from `readDoc` for malformed existing files in [src/store/documents.ts](src/store/documents.ts#L22-L27). Path registration is now precise: add `telegramSubscriptions` to `ProjectContext.paths` and populate it with `join(saivageDir, "telegram-subscriptions.json")` in `loadProject`, then consume `runtime.project.paths.telegramSubscriptions` from [src/server/telegram-bot.ts](src/server/telegram-bot.ts).

The test plan is also executable against this repo's Vitest setup. It covers the key behavioral contracts: first boot with no file, persisted chat-id bootstrapping, corrupt persistence failing loudly, authorized and unauthorized `/subscribe`, `/unsubscribe`, and ephemeral plain-text sessions that do not persist notification destinations.

## Required changes

None.

## Strengths

- The revised design is now internally consistent about config versus persisted destination state.
- The revised plan gives an implementer concrete file ownership, missing-file semantics, and focused tests.
- The chosen proposal addresses the root namespace error rather than only deleting the visible bad loop.

VERDICT: APPROVED