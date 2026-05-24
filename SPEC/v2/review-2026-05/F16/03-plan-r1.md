# F16 — Plan (r1)

Plan for the recommended Proposal B: split inbound auth (`allowedUserIds`) from outbound notification destinations (persisted, chat-id-keyed subscriptions, established via `/subscribe`).

## Ordered edit steps

1. **Add the subscriptions schema** in [src/types.ts](src/types.ts):
   - New `TelegramSubscriptionsSchema = z.object({ chatIds: z.array(z.number()).default([]) })` and exported `TelegramSubscriptions` type. Keep it small; only `chatIds` is needed today.

2. **Register the document path** alongside the other `.saivage/*.json` paths:
   - In whichever file enumerates document paths used by `readDoc`/`writeDoc` (see [src/store/documents.ts](src/store/documents.ts) and the project-paths helper in [src/store/project.ts](src/store/project.ts)), add `telegramSubscriptions: ".saivage/telegram-subscriptions.json"`.

3. **Edit [src/server/telegram-bot.ts](src/server/telegram-bot.ts)** end-to-end:
   - Remove the pre-subscribe loop at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L134-L139). Replace with a single `log.info` line stating the new boot behaviour.
   - At startup, load the persisted subscriptions via `readDoc(paths.telegramSubscriptions, TelegramSubscriptionsSchema)` (returning `{ chatIds: [] }` if missing) and call `getOrCreateSession(chatId)` for each. Wrap with `try/catch` only at this single boundary (boot), per the "validate at boundaries" guideline.
   - Inside `bot.on("message:text", …)`:
     - Keep the existing allow-list check on `ctx.from?.id`.
     - Before falling through to `getOrCreateSession(chatId)` + `pushMessage`, branch on `text.trim()`:
       - `"/subscribe"` (optionally followed by whitespace): add `chatId` to the persisted set (read-modify-write through `writeDoc`), call `getOrCreateSession(chatId)`, send a confirmation via `bot.api.sendMessage`. Do nothing if already subscribed.
       - `"/unsubscribe"`: remove `chatId` from the set, close and delete the session if present, send a confirmation. Do nothing if not subscribed.
     - All other text: existing `getOrCreateSession(chatId)` + `pushMessage` path — but **do not** persist; reactive sessions remain ephemeral. Only `/subscribe` writes to disk. This keeps the persisted set as the explicit "notification destinations" registry.
   - In the `stop` returned object, also drop the live sessions map (already done); no change needed for persistence — subscriptions survive across restarts by design.

4. **Update config-shape consumers** (fixture-only, no behavioural change):
   - [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L282) and [src/providers/router.test.ts](src/providers/router.test.ts#L29) currently spell `telegram: { botToken: "", allowedUserIds: [] }`. They stay valid because the schema shape is unchanged.

5. **Add tests** in a new [src/server/telegram-bot.test.ts](src/server/telegram-bot.test.ts):
   - Stub `bot.api.sendMessage` and `bot.on` via a minimal fake (Vitest `vi.mock("grammy")`). The goal is to test the message-routing logic in isolation, not grammy itself.
   - Test cases:
     - **Boot with empty persisted file**: no sessions created until a message arrives.
     - **Boot with persisted `chatIds: [42, -1001]`**: two sessions created at boot, keyed by those chat-ids.
     - **Inbound `/subscribe` from allow-listed user in a new chat-id**: persisted set updated, confirmation sent, session created.
     - **Inbound `/subscribe` from a non-allow-listed user**: rejected before subscription is written; persisted file unchanged.
     - **Inbound `/unsubscribe` from allow-listed user**: persisted set updated, session removed.
     - **Inbound plain text from allow-listed user without prior `/subscribe`**: a reactive session is created and the text is forwarded; persisted set is **not** modified.
   - Use [src/store/documents.ts](src/store/documents.ts) against a per-test `tmpdir` (the existing test files for the document layer use this pattern; mirror it).

## Test strategy

- Existing tests that cover this code: none for `telegram-bot.ts`; [src/channels/telegram.test.ts](src/channels/telegram.test.ts) only covers the channel's markdown converter and is unaffected by this change.
- New tests: the file in step 5.
- Commands to run:
  - `npm run typecheck`
  - `npm run build`
  - `npx vitest run src/server/telegram-bot.test.ts`
  - `npx vitest run src/channels/telegram.test.ts` (regression sanity)
- Full suite before merge: `npx vitest run`.

## Rollback strategy

Single squash commit. Revert restores the old pre-subscribe behaviour. The new persisted file `.saivage/telegram-subscriptions.json` is harmless if left behind after a revert (it is simply unread). No DB, no schema migration in the runtime sense.

## Cross-issue ordering note

Independent of other Fxx items. F16 is filed as transversality=local in [F16-telegram-bot-userid-as-chatid.md](../F16-telegram-bot-userid-as-chatid.md) and the [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md) only references this file under Server & bootstrap. Can ship before or after any other Fxx without ordering constraints.
