# F16 — Plan (r2)

## Changes from r1

- Step that loads the persisted subscriptions at boot now uses `readDocOrNull` (verified at [src/store/documents.ts](src/store/documents.ts#L29-L36)) instead of `readDoc` (which calls `readFileSync` unconditionally at [src/store/documents.ts](src/store/documents.ts#L22-L27) and would throw on first boot when no file exists). Missing-file semantics are explicit: `?? { chatIds: [] }`. Invalid JSON or schema failures remain loud — they continue to throw from `readDocOrNull` → `readDoc` → `JSON.parse`/`schema.parse`, and the boot is wrapped so this surfaces as a fatal startup error.
- Path-registration step is rewritten to be precise. The new path is registered as an absolute path on `ProjectContext.paths` in [src/store/project.ts](src/store/project.ts#L29-L47) and populated in `loadProject` at [src/store/project.ts](src/store/project.ts#L71-L88). It is **not** added to [src/store/documents.ts](src/store/documents.ts), which is a generic CRUD module and does not enumerate project paths. The relative string `.saivage/telegram-subscriptions.json` is not stored; the absolute `join(saivageDir, "telegram-subscriptions.json")` is.
- Removed the fixture-only step about [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts) and [src/providers/router.test.ts](src/providers/router.test.ts): the runtime config schema in [src/config.ts](src/config.ts#L98-L103) is not changing, so no fixture needs updating.

Plan for the recommended Proposal B: split inbound auth (`allowedUserIds`) from outbound notification destinations (persisted, chat-id-keyed subscriptions, established via `/subscribe`).

## Ordered edit steps

1. **Add the subscriptions schema** in [src/types.ts](src/types.ts):
   - New `TelegramSubscriptionsSchema = z.object({ chatIds: z.array(z.number()).default([]) })` and exported `TelegramSubscriptions` type. Keep it small; only `chatIds` is needed today.

2. **Register the document path on `ProjectContext`** in [src/store/project.ts](src/store/project.ts):
   - In the `ProjectContext.paths` type at [src/store/project.ts](src/store/project.ts#L29-L47), add a new field: `telegramSubscriptions: string;`.
   - In `loadProject` at [src/store/project.ts](src/store/project.ts#L71-L88), add the corresponding entry to the `paths` object: `telegramSubscriptions: join(saivageDir, "telegram-subscriptions.json"),`.
   - Do **not** touch [src/store/documents.ts](src/store/documents.ts); it is a generic CRUD module and is unaware of project paths.

3. **Edit [src/server/telegram-bot.ts](src/server/telegram-bot.ts)** end-to-end:
   - Remove the pre-subscribe loop at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L134-L139). Replace with a single `log.info` line stating the new boot behaviour.
   - At startup, load the persisted subscriptions with explicit missing-file handling:

     ```ts
     const subsPath = runtime.project.paths.telegramSubscriptions;
     const persisted =
       readDocOrNull(subsPath, TelegramSubscriptionsSchema) ?? { chatIds: [] };
     for (const chatId of persisted.chatIds) getOrCreateSession(chatId);
     ```

     `readDocOrNull` returns `null` only for missing files; malformed JSON or schema-invalid content still throws, and the boot wrapper at this single boundary lets that surface as a fatal startup error (per the "validate at boundaries" guideline).
   - Inside `bot.on("message:text", …)`:
     - Keep the existing allow-list check on `ctx.from?.id`.
     - Before falling through to `getOrCreateSession(chatId)` + `pushMessage`, branch on `text.trim()`:
       - `"/subscribe"` (optionally followed by whitespace): read the current persisted set with the same `readDocOrNull(subsPath, TelegramSubscriptionsSchema) ?? { chatIds: [] }` idiom, add `chatId` if missing, write back via `writeDoc(subsPath, next, TelegramSubscriptionsSchema)`, call `getOrCreateSession(chatId)`, send a confirmation via `bot.api.sendMessage`. Do nothing if already subscribed.
       - `"/unsubscribe"`: same read-modify-write pattern; remove `chatId` from the set, close and delete the session if present, send a confirmation. Do nothing if not subscribed.
     - All other text: existing `getOrCreateSession(chatId)` + `pushMessage` path — but **do not** persist; reactive sessions remain ephemeral. Only `/subscribe` writes to disk. This keeps the persisted set as the explicit "notification destinations" registry.
   - In the `stop` returned object, also drop the live sessions map (already done); no change needed for persistence — subscriptions survive across restarts by design.

4. **Add tests** in a new [src/server/telegram-bot.test.ts](src/server/telegram-bot.test.ts):
   - Stub `bot.api.sendMessage` and `bot.on` via a minimal fake (Vitest `vi.mock("grammy")`). The goal is to test the message-routing logic in isolation, not grammy itself.
   - Build the test `runtime.project.paths.telegramSubscriptions` against a per-test `tmpdir`; existing tests for the document layer (see [src/store/documents.test.ts](src/store/documents.test.ts#L98-L107) for the `readDocOrNull` missing-file pattern) follow the same shape.
   - Test cases:
     - **Boot with no persisted file**: `readDocOrNull` returns `null`, defaults to `{ chatIds: [] }`, no sessions created until a message arrives.
     - **Boot with persisted `chatIds: [42, -1001]`**: two sessions created at boot, keyed by those chat-ids.
     - **Boot with corrupt persisted file** (invalid JSON or schema-violating content): startup throws; bot does not enter a half-initialized state.
     - **Inbound `/subscribe` from allow-listed user in a new chat-id**: persisted set updated on disk, confirmation sent, session created.
     - **Inbound `/subscribe` from a non-allow-listed user**: rejected before subscription is written; persisted file unchanged on disk.
     - **Inbound `/unsubscribe` from allow-listed user**: persisted set updated on disk, session removed.
     - **Inbound plain text from allow-listed user without prior `/subscribe`**: a reactive session is created and the text is forwarded; persisted set is **not** modified on disk.

## Test strategy

- Existing tests that cover this code: none for `telegram-bot.ts`; [src/channels/telegram.test.ts](src/channels/telegram.test.ts) only covers the channel's markdown converter and is unaffected by this change.
- New tests: the file in step 4.
- Commands to run:
  - `npm run typecheck`
  - `npm run build`
  - `npx vitest run src/server/telegram-bot.test.ts`
  - `npx vitest run src/channels/telegram.test.ts` (regression sanity)
  - `npx vitest run src/store/project.test.ts` (verify the new `paths.telegramSubscriptions` entry does not break path resolution; if no such test file exists, no extra command is needed beyond the full suite)
- Full suite before merge: `npx vitest run`.

## Rollback strategy

Single squash commit. Revert restores the old pre-subscribe behaviour and removes the new `paths.telegramSubscriptions` entry. The new persisted file `.saivage/telegram-subscriptions.json` is harmless if left behind after a revert (it is simply unread). No DB, no schema migration in the runtime sense.

## Cross-issue ordering note

Independent of other Fxx items. F16 is filed as transversality=local in [F16-telegram-bot-userid-as-chatid.md](../F16-telegram-bot-userid-as-chatid.md) and the [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md) only references this file under Server & bootstrap. Can ship before or after any other Fxx without ordering constraints.
