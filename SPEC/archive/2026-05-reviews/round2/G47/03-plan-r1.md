# G47 — Plan (Round 1)

- **Analysis**: [01-analysis-r1.md](01-analysis-r1.md)
- **Design**: [02-design-r1.md](02-design-r1.md)

## 1. Sequenced steps

### Step 1 — Schema rewrite (types)

Edit [src/types.ts L82-L86](../../../../src/types.ts#L82-L86):

- Add `TelegramSubscriptionEntrySchema = z.object({ chatId, userId, subscribedAt })`.
- Replace `TelegramSubscriptionsSchema` body with `{ entries: z.array(TelegramSubscriptionEntrySchema).default([]) }`.
- Export `TelegramSubscriptionEntry` type alongside `TelegramSubscriptions`.

No migration shim. No dual-read.

### Step 2 — Authorization helper

In [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts), add module-private `isAuthorizedTelegramUser(userId, allowed)` near the bottom of the file (alongside `telegramSessionId` at [L213-L215](../../../../src/server/telegram-bot.ts#L213-L215)).

### Step 3 — Inbound gate uses helper + replies

Replace the inline check at [telegram-bot.ts L137-L140](../../../../src/server/telegram-bot.ts#L137-L140) with the helper call and `await ctx.reply("Not authorized.", { link_preview_options: { is_disabled: true } })`.

### Step 4 — Subscription handlers consume new schema

Update `/subscribe` ([L142-L154](../../../../src/server/telegram-bot.ts#L142-L154)) and `/unsubscribe` ([L156-L170](../../../../src/server/telegram-bot.ts#L156-L170)) to operate on `entries` and persist `{ chatId, userId, subscribedAt: new Date().toISOString() }`.

### Step 5 — Boot hydration filters through allowlist

Replace [L188-L191](../../../../src/server/telegram-bot.ts#L188-L191) with the survivors/dropped split per design §3.4; rewrite the file when `dropped.length > 0`.

### Step 6 — Startup split

Replace [L194-L200](../../../../src/server/telegram-bot.ts#L194-L200):

- Insert `await bot.init();` before `bot.start(...)`.
- Add `log.info` line citing `bot.botInfo.username`.
- Change `bot.start({...})` to `void bot.start({...}).catch((err) => log.error(...))`.

### Step 7 — Test adjustments

Edit [src/server/telegram-bot.test.ts](../../../../src/server/telegram-bot.test.ts):

- Update the `grammy` mock to expose `bot.init()` (returns a resolved promise by default) and `bot.botInfo` (set by init).
- Update the four schema-touching tests to read/write `entries` instead of `chatIds`.
- Add new tests (see §3).

### Step 8 — Build + lint + tests

Run `npm run build` and `npm test` from the saivage workspace root.

## 2. Order of file edits

1. [src/types.ts](../../../../src/types.ts#L82-L86) — schema rewrite.
2. [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts) — fix in one pass: helper, gate, handlers, hydration, startup.
3. [src/server/telegram-bot.test.ts](../../../../src/server/telegram-bot.test.ts) — mock + existing-test adjustments + new tests.

## 3. Regression test plan

All tests live in [src/server/telegram-bot.test.ts](../../../../src/server/telegram-bot.test.ts).

### 3.1 Adjusted existing tests (schema change)

| # | Existing test | Adjustment |
|---|---|---|
| 1 | `boots with no persisted subscriptions and creates no sessions` | unchanged — asserts file is `null`. |
| 2 | `/subscribe from allow-listed user persists chat-id and confirms` | assert persisted shape is `{ entries: [{ chatId: 100, userId: 42, subscribedAt: <ISO> }] }`. Use `expect.stringMatching(/^\d{4}-/)` only inside the test (test code, not production parser — rule §1 applies to user-intent parsing). |
| 3 | `/subscribe from non-allow-listed user is rejected; no persistence` | additionally assert `botInstances[0].api.sendMessage` *was* called with `"Not authorized."`. |
| 4 | `/unsubscribe removes chat-id and confirms` | seed file with `{ entries: [{chatId:100,userId:42,subscribedAt:"..."}, {chatId:200,userId:42,subscribedAt:"..."}] }`; assert result `entries` array contains only `chatId: 200`. |
| 5 | `boot with persisted chat-ids creates sessions at startup` | seed two entries with allowed userIds; assert two `ChatAgent.create` calls. |
| 6 | `plain text from allow-listed user does NOT persist the chat-id` | unchanged in intent; asserts `entries` remains empty. |
| 7 | `boot with corrupt persisted file throws (fatal)` | unchanged. |

### 3.2 New regression tests

T1. **Unauthorized inbound elicits a reply.** Seed `allowedUserIds: [42]`; dispatch a message from `userId: 999`; expect `bot.api.sendMessage` called with `(chatId, "Not authorized.", { link_preview_options: { is_disabled: true } })`.

T2. **Boot drops persisted entries whose userId is no longer allowed.** Pre-seed file with `entries: [{chatId:100,userId:42,subscribedAt:"..."}, {chatId:200,userId:999,subscribedAt:"..."}]`. Start bot with `allowedUserIds: [42]`. Assert: (a) file is rewritten to `{ entries: [{chatId:100,userId:42,...}] }`; (b) only one `ChatAgent.create` call; (c) at least one `log.warn` line citing "Dropped".

T3. **Open mode (empty allowlist) preserves all persisted entries.** Pre-seed two entries; start bot with `allowedUserIds: []`. Assert file is unchanged and both sessions are created.

T4. **`bot.init()` rejection propagates to caller.** Make the grammy mock's `init` reject with `new Error("invalid token")`. Expect `startTelegramBot(runtime)` to reject with that error.

T5. **`bot.start()` is invoked after `bot.init()` and not awaited synchronously.** Use a deferred mock for `start` (never resolves). Assert `startTelegramBot` resolves (does not hang), `bot.init` was called before `bot.start`.

T6. **`/subscribe` persists the inbound userId.** Dispatch `/subscribe` from `userId: 42, chatId: 100`. Assert persisted entry has `userId === 42` and `chatId === 100`.

T7. **Helper unit semantics.** Direct unit test of `isAuthorizedTelegramUser` (export it from the module for testability, or import via a `__test__` re-export). Cases: empty allowlist + defined userId → true; empty allowlist + undefined → false; non-empty allowlist + match → true; non-empty + miss → false; non-empty + undefined → false.

### 3.3 Non-functional checks

- `npm run build` — TypeScript compilation must succeed; `chatIds` must not remain in any consumer.
- `grep -rn 'chatIds' src/ web/` — must return no matches in code (only test fixtures or new docs may reference the term in prose).
- `npm test -- src/server/telegram-bot.test.ts` — full suite green.
- `npm test` — full saivage suite green (catch incidental consumers of the old schema if any).

### 3.4 Manual smoke (operator-side, optional)

Out of automated scope but recommended in the rollout note:

1. Start saivage with an invalid `telegram.botToken`; observe `Telegram bot failed to start: ...` log and that the server keeps running (validates the cli.ts `try/catch` is load-bearing).
2. Start with a valid token, `/subscribe` as an allowed user, restart with that user removed from `allowedUserIds`; verify on-disk file no longer contains the entry and that no notification arrives.

## 4. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Operators upgrade and lose all subscriptions (file deleted). | Documented in the schema-rewrite commit message; per project no-backward-compat rule this is expected. Subscriptions are user-initiated and trivial to re-establish via `/subscribe`. |
| `bot.init()` semantics differ across grammy minor versions. | Pin or document the minimum grammy version in [package.json](../../../../package.json); the grammy docs treat `bot.init()` as stable API since 1.x. |
| Test mocks drift from real grammy interface. | T4/T5 force the mock to expose `init` distinctly from `start`, matching production behaviour. |

## 5. Done criteria

- All seven new tests (T1-T7) pass.
- All adjusted existing tests pass.
- `grep -rn 'chatIds' src/ web/` returns no production-code matches.
- `bot.start` is not awaited; `bot.init` is awaited; the surrounding `startTelegramBot` rejects when init rejects.
- Unauthorized inbound elicits a Telegram reply.
- Boot hydration writes the survivors-only file when entries are dropped.
