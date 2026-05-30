# F16 — Design (r2)

## Changes from r1

- Proposal B's scope list no longer claims [src/config.ts](src/config.ts) gains a typed split. Verified at [src/config.ts](src/config.ts#L98-L103): the runtime config schema keeps `telegram.botToken: string` and `telegram.allowedUserIds: number[]` unchanged. The "typed split" is realized entirely by introducing a separate, persisted `TelegramSubscriptionsSchema` document in [src/types.ts](src/types.ts), not by mutating the runtime config schema.
- Consequently, the fixture-update line for [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts) and [src/providers/router.test.ts](src/providers/router.test.ts) is removed — no fixture change is needed because no config field is added or renamed.
- Recommendation and rationale are unchanged; only the scope/fixture wording is corrected.

## Proposal A — Drop the pre-subscribe loop (focused fix)

**Scope (files touched)**:
- [src/server/telegram-bot.ts](src/server/telegram-bot.ts) — remove the pre-subscribe loop and the log lines wrapped around it.

**What gets added**: nothing.

**What gets removed**:
- The `if (allowedUserIds.size > 0) { for (const userId of allowedUserIds) getOrCreateSession(userId); … }` block at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L134-L139).
- The companion `log.warn("[telegram] No allowedUserIds configured; …")`, which becomes the only behaviour and is now redundant noise. Replace the whole `if/else` with a single `log.info` describing the real semantics (sessions created on first authenticated message).

**Behaviour after the change**:
- Sessions are created lazily inside `bot.on("message:text", …)` at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L113-L124), which already uses `ctx.chat.id` for the session key.
- An allow-listed user gets notifications in whichever chat (DM, group, supergroup) they greeted the bot from.
- Operators cannot accidentally cause sendMessage failures or DM-leak by typing a group/channel id into `allowedUserIds`: the field is now used exclusively for the inbound `from.id` allow-check, matching its name.

**Risk**:
- Low. The lazy path is already exercised whenever `allowedUserIds` is empty, so the code path is not new.
- One behavioural change visible to operators: notifications no longer arrive until the user has sent at least one message to the bot in the target chat. This is the right invariant per the issue (no pre-subscribe), and it is straightforward to communicate.

**What it enables**:
- Removes the cross-namespace category error and makes the inbound allow-list match its name. No cross-link to other Fxx; F16 is local per [00-INDEX.md](../00-INDEX.md) and [F16-telegram-bot-userid-as-chatid.md](../F16-telegram-bot-userid-as-chatid.md).

**What it forbids**:
- Re-introducing any pre-subscribe behaviour keyed by user-id. If notifications-to-chats-without-prior-greeting are ever wanted, the right shape is Proposal B (an explicit subscription registry), not the current code.

**Recommendation note**: Correct, minimal, removes the unsafe pattern. The remaining design smell — that `allowedUserIds` is both "auth" and "implicit notification fan-out" — survives, but in a defanged form: the bad fan-out is gone, the auth meaning is preserved.

## Proposal B — Split inbound auth from outbound notification destinations (one level up)

**Scope (files touched)**:
- [src/server/telegram-bot.ts](src/server/telegram-bot.ts) — restructured around two collections (auth allow-list vs. persisted destination set).
- [src/types.ts](src/types.ts) — add `TelegramSubscriptionsSchema = z.object({ chatIds: z.array(z.number()).default([]) })` and exported `TelegramSubscriptions` type.
- [src/store/project.ts](src/store/project.ts) — add `telegramSubscriptions: join(saivageDir, "telegram-subscriptions.json")` to `ProjectContext.paths` at [src/store/project.ts](src/store/project.ts#L29-L47) and to the `paths` object in `loadProject` at [src/store/project.ts](src/store/project.ts#L71-L88).
- New test [src/server/telegram-bot.test.ts](src/server/telegram-bot.test.ts) — covers the new `/subscribe` and `/unsubscribe` flow and the auth-vs-destination split.

**Explicitly NOT touched**:
- [src/config.ts](src/config.ts) — runtime config schema is unchanged. `telegram.allowedUserIds` keeps its existing shape at [src/config.ts](src/config.ts#L98-L103); only its semantics narrow to "inbound auth allow-list".
- [src/store/documents.ts](src/store/documents.ts) — this file already provides `readDoc`/`readDocOrNull`/`writeDoc`. It does not enumerate project document paths and does not need editing.

**What gets added**:
- `telegram.allowedUserIds: number[]` keeps its name and its meaning, but its sole consumer is the inbound `ctx.from.id` allow-check. The Zod field type is unchanged.
- Two slash commands handled inside the `message:text` handler:
  - `/subscribe` — only allow-listed users can run it. Adds `ctx.chat.id` to a persisted `SubscribedChats` set and creates the session (same as today's lazy path).
  - `/unsubscribe` — removes `ctx.chat.id` from the set and closes the session.
- A small persisted document `telegram-subscriptions.json` written through [src/store/documents.ts](src/store/documents.ts) (Zod-validated, atomic write — the same pattern used by every other on-disk document). Schema added to [src/types.ts](src/types.ts). Its absolute path lives on `ProjectContext.paths.telegramSubscriptions`.
- A boot-time loader that reads the persisted file with `readDocOrNull(runtime.project.paths.telegramSubscriptions, TelegramSubscriptionsSchema) ?? { chatIds: [] }` and, for every persisted `chatId`, calls the existing lazy session factory once. This is the only "pre-subscribe", and it operates exclusively in the chat-id namespace, so the bug class is structurally impossible.

**What gets removed**:
- The `allowedUserIds` pre-subscribe loop at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L134-L139).
- The implicit assumption that "allow-listed" implies "notify". Per project guideline 1 (no backward compatibility), no shim, no rename, no deprecation window.

**Behaviour after the change**:
- First-time flow: operator adds their user-id to `allowedUserIds`, starts a DM (or invites the bot to a group, then messages it there), sends `/subscribe`. From then on, notifications flow to that chat-id.
- Group flow works first-class: `/subscribe` from inside a group registers the group's negative `chat.id`, so notifications go to the group, not the user's DM.
- Restart preserves subscriptions because they live on disk, keyed in the correct namespace.
- First boot with no subscriptions file: `readDocOrNull` returns `null`, the default `{ chatIds: [] }` is used, and no sessions are created until a message arrives.

**Risk**:
- Medium. The change adds a new persisted document and slash-command surface area. Schema validation and the existing atomic writer keep blast radius small.
- One UX concern: the flow now requires an explicit `/subscribe`. Acceptable trade for a model that cannot send DMs to the wrong identity space.
- Test coverage needs to be added (none exists today for `telegram-bot.ts`); this is a benefit but it is upfront work.

**What it enables**:
- A clean foundation for any follow-up Telegram work (e.g., per-chat filter levels, mute commands).
- Self-documenting on-disk shape: each persisted field maps to a single Telegram namespace.

**What it forbids**:
- Conflating "auth" with "destination" anywhere in the Telegram surface.
- Storing subscriptions implicitly (e.g., via the live session map). They must be a persisted document so subscriptions survive process restarts without re-triggering the bug-prone pre-subscribe pattern keyed by something other than `chat.id`.

**Recommendation note**: Materially better model, removes the underlying conflation. Costs are real but contained, and the new tests increase coverage of a previously untested file. There is no existing Saivage feature that depends on auto-notify-on-allow-list, so removing it is a clean refactor.

## Recommendation

**Proposal B.**

Reasons:
- The issue is filed as `unsafe-pattern, severity=high` precisely because the root cause is a namespace confusion encoded in the way `allowedUserIds` is consumed. Proposal A removes the symptomatic line but leaves `allowedUserIds` doing double duty in operators' mental model; the next person to "make notifications work" is likely to re-introduce a variant of the same pattern.
- Proposal B costs roughly: ~50 LOC of subscription persistence + slash-command handling + a small Zod schema and a new entry on `ProjectContext.paths`, plus a focused test file. That is well below the threshold where the project guideline against over-engineering would bite, and the test surface fills a gap (`telegram-bot.ts` currently has no tests).
- Project guideline 1 (no backward compatibility) makes B cheaper than it would otherwise be: the change deletes the old behaviour outright, no migration shim.
- F16 is marked transversality=local, so the blast radius is contained to the Telegram surface; B does not bleed into other subsystems.
