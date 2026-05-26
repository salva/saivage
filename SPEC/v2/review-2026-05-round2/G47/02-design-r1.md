# G47 — Design (Round 1)

- **Analysis**: [01-analysis-r1.md](01-analysis-r1.md)

## 1. Proposals

### Proposal A — Targeted fix, schema rewrite, identity-bearing persistence (RECOMMENDED)

Fix all three defects within the Telegram channel boundary:

- **A1**. Reply to unauthorized inbound with a single literal line: `Not authorized.` Disable link previews; keep the existing operator-side `log.warn`.
- **A2**. Replace the unawaited `bot.start({...})` with `await bot.init()` (grammy's documented startup-validation primitive — it performs a `getMe` call and stores `bot.botInfo`) followed by a fire-and-forget `bot.start({...}).catch(...)`. `bot.init()` reliably rejects on invalid token, 401, and network errors; `startTelegramBot` propagates the rejection, which the existing `try/catch` in [src/server/cli.ts L332-L338](../../../../src/server/cli.ts#L332-L338) already handles by logging and continuing without Telegram.
- **A3**. Replace `TelegramSubscriptionsSchema = { chatIds: number[] }` with `{ entries: { chatId: number; userId: number; subscribedAt: string }[] }`. No migration shim — per the architecture-first / no-backward-compat project rule, a Zod-mismatch on the old shape is fatal at boot, matching the existing "corrupt file throws" contract.
- **A4**. Persist `{ chatId, userId, subscribedAt }` on `/subscribe`. On boot, filter `entries` through `allowedUserIds` (when non-empty); for each entry whose `userId` is not allowed, drop it and rewrite the file. Survivors are hydrated.
- **A5**. Extract a pure helper `isAuthorizedTelegramUser(userId: number | undefined, allowed: ReadonlySet<number>): boolean` that returns `true` when `allowed.size === 0` (open mode) or `userId !== undefined && allowed.has(userId)`. Single decision point used by the inbound gate and the hydration filter — no chance of the two paths drifting again.

Touched files:

- [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts) — gate, hydration filter, init/start split, schema-shape consumers.
- [src/types.ts](../../../../src/types.ts#L82-L86) — `TelegramSubscriptionsSchema` rewrite; bump exported `TelegramSubscriptions` type.
- [src/server/telegram-bot.test.ts](../../../../src/server/telegram-bot.test.ts) — adapt existing tests to the new schema; add four new tests (see plan §3).

No changes to: [src/config.ts](../../../../src/config.ts) (telegram allowlist shape unchanged), [src/channels/telegram.ts](../../../../src/channels/telegram.ts) (markdown splitter — out of scope), [src/server/cli.ts](../../../../src/server/cli.ts) (caller already wraps in `try/catch`).

### Proposal B — Generalized `ChannelAuthorizer` interface

Introduce `src/channels/authorizer.ts` exporting:

```ts
type ChannelPrincipal =
  | { kind: "telegram-user"; userId: number }
  | { kind: "ws-token"; token: string };

interface ChannelAuthorizer {
  isAuthorized(p: ChannelPrincipal): boolean;
}
```

Build a single instance in `bootstrap.ts` from `config.telegram.allowedUserIds` + `process.env.SAIVAGE_API_TOKEN`, inject into both `startTelegramBot` and the WS upgrade in [src/server/server.ts](../../../../src/server/server.ts#L663-L666). Persist `{ chatId, userId, subscribedAt }` as in Proposal A.

Pros: one mental model for channel authz; future channels (e.g. CLI re-add, IRC) plug in trivially.

Cons:

- The tagged-union principal is a leaky abstraction — each call site already knows which variant it produces and never branches on the union.
- Forces touching [src/server/server.ts](../../../../src/server/server.ts) and the bootstrap wiring, materially expanding the blast radius and overlapping with [G40](../G40-auth-documentation-missing-saivage-api-token.md), which audits the WS token gate end-to-end.
- Violates "avoid over-engineering": no consumer demands the abstraction today.

## 2. Recommendation

**Adopt Proposal A.** It is fully contained within the Telegram channel boundary, eliminates all three symptoms, and applies the no-backward-compat rule cleanly to the persistence schema. The cross-channel generalization is left to G40 where the WS token model is being re-examined.

## 3. Detailed design (Proposal A)

### 3.1 Authorization helper

New top-level (module-private) helper in [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts):

```ts
function isAuthorizedTelegramUser(
  userId: number | undefined,
  allowed: ReadonlySet<number>,
): boolean {
  if (allowed.size === 0) return true; // open mode preserved
  return userId !== undefined && allowed.has(userId);
}
```

Used at two sites: the `bot.on("message:text")` gate (replacing the current inline check at L137) and the boot-hydration filter (replacing the unconditional loop at L190).

### 3.2 Inbound reply

```ts
if (!isAuthorizedTelegramUser(userId, allowedUserIds)) {
  log.warn(`[telegram] Rejected message from unauthorized user ${userId}`);
  await ctx.reply("Not authorized.", {
    link_preview_options: { is_disabled: true },
  });
  return;
}
```

Plain-text reply — no MarkdownV2, no escaping concerns, no fragile parsing.

### 3.3 Persistence schema (no migration shim)

[src/types.ts L82-L86](../../../../src/types.ts#L82-L86) becomes:

```ts
export const TelegramSubscriptionEntrySchema = z.object({
  chatId: z.number(),
  userId: z.number(),
  subscribedAt: z.string(),
});
export const TelegramSubscriptionsSchema = z.object({
  entries: z.array(TelegramSubscriptionEntrySchema).default([]),
});
export type TelegramSubscriptionEntry = z.infer<typeof TelegramSubscriptionEntrySchema>;
export type TelegramSubscriptions = z.infer<typeof TelegramSubscriptionsSchema>;
```

All readers/writers update accordingly. A pre-upgrade `telegram-subscriptions.json` shaped `{ chatIds: [...] }` fails Zod validation at boot → `startTelegramBot` rejects → the existing `try/catch` in cli.ts logs and continues without Telegram. Operators delete the stale file and re-issue `/subscribe`.

### 3.4 Boot hydration with allowlist filter

```ts
const persisted = await readSubs();
const survivors: TelegramSubscriptionEntry[] = [];
const dropped: TelegramSubscriptionEntry[] = [];
for (const entry of persisted.entries) {
  if (isAuthorizedTelegramUser(entry.userId, allowedUserIds)) {
    survivors.push(entry);
  } else {
    dropped.push(entry);
  }
}
if (dropped.length > 0) {
  log.warn(
    `[telegram] Dropped ${dropped.length} persisted subscription(s) ` +
    `whose userId is no longer in allowedUserIds`,
  );
  await writeSubs({ entries: survivors });
}
for (const entry of survivors) {
  await getOrCreateSession(entry.chatId);
}
log.info(`[telegram] Restored ${survivors.length} persisted subscription(s)`);
```

### 3.5 `/subscribe` handler

```ts
if (text === "/subscribe" || text.startsWith("/subscribe ")) {
  const subs = await readSubs();
  if (!subs.entries.some((e) => e.chatId === chatId)) {
    await writeSubs({
      entries: [
        ...subs.entries,
        { chatId, userId: userId!, subscribedAt: new Date().toISOString() },
      ],
    });
    await getOrCreateSession(chatId);
    await bot.api.sendMessage(chatId, "Subscribed to project notifications.");
    log.info(`[telegram] Chat ${chatId} (user ${userId}) subscribed`);
  } else {
    await bot.api.sendMessage(chatId, "Already subscribed.");
  }
  return;
}
```

`userId!` is sound here because the authz gate above guarantees `userId` is defined (an unauthorized message with `userId === undefined` is rejected before this point; in open mode where `allowed.size === 0`, grammy's `message:text` filter still populates `ctx.from?.id` for non-channel messages — but to be safe, we also require `userId !== undefined` in the gate even in open mode by tightening `isAuthorizedTelegramUser` to require `userId !== undefined` unconditionally; see §3.6).

### 3.6 Tightened gate (final form)

```ts
function isAuthorizedTelegramUser(
  userId: number | undefined,
  allowed: ReadonlySet<number>,
): boolean {
  if (userId === undefined) return false;
  if (allowed.size === 0) return true;
  return allowed.has(userId);
}
```

A `message:text` from a channel post (no `from`) is now rejected even in open mode — this is the correct behaviour (channel posts cannot subscribe). The "open mode" log warning at [telegram-bot.ts L184-L186](../../../../src/server/telegram-bot.ts#L184-L186) stays.

### 3.7 Startup: split `init` and `start`

```ts
// Validate token, fetch botInfo, surface errors synchronously.
await bot.init();
log.info(`[telegram] Bot validated: @${bot.botInfo.username} (${bot.botInfo.id})`);

// Long polling — fire-and-forget; failures after init are reported to bot.catch.
void bot.start({
  onStart: (botInfo) => {
    log.info(`[telegram] Long polling started: @${botInfo.username}`);
  },
}).catch((err) => {
  log.error(`[telegram] Polling stopped with error: ${err instanceof Error ? err.message : err}`);
});
```

`bot.init()` rejects with a typed grammy `GrammyError` on bad token / 401 — propagation through `startTelegramBot` is automatic. The post-init `.catch` covers the rare case where long polling dies later (e.g. revoked token at runtime); the existing `bot.catch(...)` handler at [telegram-bot.ts L180-L182](../../../../src/server/telegram-bot.ts#L180-L182) handles per-update errors and stays unchanged.

## 4. Files touched (summary)

| File | Live anchor | Change |
|---|---|---|
| [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts#L136-L140) | L136-L140 | inbound gate uses helper; replies "Not authorized." |
| [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts#L142-L160) | L142-L160 | `/subscribe` persists `{ chatId, userId, subscribedAt }`; reads `entries`. |
| [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts#L162-L178) | L162-L178 | `/unsubscribe` filters by `chatId` against `entries`. |
| [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts#L188-L191) | L188-L191 | hydration filtered through allowlist; disk rewritten on drop. |
| [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts#L194-L200) | L194-L200 | `await bot.init()`; then fire-and-forget `bot.start().catch(...)`. |
| [src/types.ts](../../../../src/types.ts#L82-L86) | L82-L86 | `TelegramSubscriptionsSchema` rewrite + new `TelegramSubscriptionEntrySchema`. |
| [src/server/telegram-bot.test.ts](../../../../src/server/telegram-bot.test.ts) | (full) | adapt existing tests; add new ones (see plan §3). |

No changes: [src/config.ts](../../../../src/config.ts#L130-L135), [src/server/cli.ts](../../../../src/server/cli.ts#L330-L339) (existing `try/catch` is now load-bearing — flagged in plan as a doc note), [src/channels/telegram.ts](../../../../src/channels/telegram.ts), [src/channels/websocket.ts](../../../../src/channels/websocket.ts), [src/server/server.ts](../../../../src/server/server.ts).

## 5. Compliance with project rules

- **Architecture-first / no backward compat**: schema rewrite drops `chatIds` outright; no migration helper, no dual-read support.
- **Remove obsolete code**: `chatIds` field disappears from the type system; consumers compile-error if any remain (Zod + TS guarantee).
- **No regex for user-intent parsing**: gate uses set membership; command parsing keeps literal `===` / `startsWith` checks.
- **Avoid hardcoded values**: no new hardcoded values introduced. `allowedUserIds` remains the sole config primitive.
- **Avoid over-engineering**: no new module, no abstract authorizer interface, no DI boilerplate.
