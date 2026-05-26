# F16 - Review (r1)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F16/01-analysis-r1.md](SPEC/v2/review-2026-05/F16/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F16/02-design-r1.md](SPEC/v2/review-2026-05/F16/02-design-r1.md)
- [SPEC/v2/review-2026-05/F16/03-plan-r1.md](SPEC/v2/review-2026-05/F16/03-plan-r1.md)

## Findings

### Analysis

The analysis is factually sound. It correctly identifies the boot-time namespace bug in [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L134-L139), the already-correct inbound path that checks `ctx.from?.id` but keys sessions by `ctx.chat.id` in [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L112-L126), and the fact that creating a `ChatAgent` immediately subscribes it to the event bus in [src/agents/chat.ts](src/agents/chat.ts#L184-L189). The spot-check of [src/events/bus.ts](src/events/bus.ts#L63-L109) confirms that every live subscription receives matching published events, so the stated notification fan-out risk is real.

### Design

The design satisfies the two-proposal requirement and the recommendation of Proposal B is appropriate for the project guideline: it removes the user-id/chat-id conflation instead of preserving the old implicit notify-on-allow-list behavior. The `/unsubscribe` lifecycle is also viable because closing the `TelegramChannel` triggers the chat agent's close handler in [src/agents/chat.ts](src/agents/chat.ts#L222-L232), and cleanup unregisters the event-bus subscription in [src/agents/chat.ts](src/agents/chat.ts#L569-L573).

One wording inconsistency should be corrected in r2: Proposal B's scope says [src/config.ts](src/config.ts) gains a typed split and fixture updates are needed for a new schema, while the same proposal and the plan say `telegram.allowedUserIds` remains unchanged and the destination split is represented by a persisted subscriptions document in [SPEC/v2/review-2026-05/F16/02-design-r1.md](SPEC/v2/review-2026-05/F16/02-design-r1.md#L35-L47) and [SPEC/v2/review-2026-05/F16/03-plan-r1.md](SPEC/v2/review-2026-05/F16/03-plan-r1.md#L24-L25). The intended design is clear, but the scope list should not tell the implementer to modify the runtime config schema if no config field is being added.

### Plan

The plan is close, but it has one concrete executability gap. It instructs startup to load subscriptions via `readDoc(paths.telegramSubscriptions, TelegramSubscriptionsSchema)` while "returning `{ chatIds: [] }` if missing" in [SPEC/v2/review-2026-05/F16/03-plan-r1.md](SPEC/v2/review-2026-05/F16/03-plan-r1.md#L13-L21). In this repo, `readDoc` directly calls `readFileSync` and does not handle missing files in [src/store/documents.ts](src/store/documents.ts#L22-L27); missing-file semantics are provided by `readDocOrNull` in [src/store/documents.ts](src/store/documents.ts#L29-L36), with tests at [src/store/documents.test.ts](src/store/documents.test.ts#L98-L107). As written, the first boot with no subscriptions file would throw before the bot starts, contradicting the proposed "Boot with empty persisted file" test.

The path-registration step also needs to be precise. Project paths are centralized as absolute paths on `ProjectContext.paths` in [src/store/project.ts](src/store/project.ts#L29-L47) and populated in [src/store/project.ts](src/store/project.ts#L71-L88). The r2 plan should explicitly add `telegramSubscriptions: join(saivageDir, "telegram-subscriptions.json")` to that interface/object and use `runtime.project.paths.telegramSubscriptions`; it should not imply that [src/store/documents.ts](src/store/documents.ts) enumerates project document paths or that the literal relative string `.saivage/telegram-subscriptions.json` should be stored in `paths`.

## Required changes

1. Revise [SPEC/v2/review-2026-05/F16/03-plan-r1.md](SPEC/v2/review-2026-05/F16/03-plan-r1.md#L13-L21) in r2 so startup uses `readDocOrNull(runtime.project.paths.telegramSubscriptions, TelegramSubscriptionsSchema) ?? { chatIds: [] }` or an equally explicit missing-file branch before validating/writing subscriptions. Keep invalid JSON/schema failures loud.
2. Revise the path-registration instruction to add an absolute `telegramSubscriptions` entry to `ProjectContext.paths` in [src/store/project.ts](src/store/project.ts#L29-L47) and `loadProject` in [src/store/project.ts](src/store/project.ts#L71-L88), then use that path from [src/server/telegram-bot.ts](src/server/telegram-bot.ts). Remove the misleading suggestion that [src/store/documents.ts](src/store/documents.ts) is the place that enumerates project paths.
3. Align the Proposal B scope in [SPEC/v2/review-2026-05/F16/02-design-r1.md](SPEC/v2/review-2026-05/F16/02-design-r1.md#L35-L47) with the actual design: either specify a real [src/config.ts](src/config.ts) schema change, or state that the runtime config schema remains unchanged and the new typed split is the persisted `TelegramSubscriptionsSchema` in [src/types.ts](src/types.ts).

## Strengths

- The root-cause analysis is accurate and grounded in the current code.
- Proposal B is architecture-first without compatibility shims, and it removes the unsafe conflation instead of only deleting one bad loop.
- The proposed tests cover the important authorization, persistence, group-chat, and ephemeral-session cases.

VERDICT: CHANGES_REQUESTED