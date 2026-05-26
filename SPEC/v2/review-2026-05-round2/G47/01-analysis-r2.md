# G47 — Analysis (Round 2)

- **Issue**: [../G47-telegram-bot-auth-and-startup-issues.md](../G47-telegram-bot-auth-and-startup-issues.md)
- **Round 1**: [01-analysis-r1.md](01-analysis-r1.md)
- **Round 1 review**: [04-review-r1.md](04-review-r1.md) — VERDICT: CHANGES_REQUESTED

## 1. Carry-over from round 1

The three-defect diagnosis stands unchanged (silent unauthorized drop, unawaited bot.start, allowlist-bypass at hydration). Evidence anchors in [01-analysis-r1.md §2](01-analysis-r1.md) are still accurate against the live source ([src/server/telegram-bot.ts L136-L140](../../../../src/server/telegram-bot.ts#L136-L140), [L188-L200](../../../../src/server/telegram-bot.ts#L188-L200), [src/types.ts L82-L86](../../../../src/types.ts#L82-L86)).

This round narrows two open items the round-1 review flagged ([04-review-r1.md](04-review-r1.md)):

- Startup contract: round 1 made bot.start fire-and-forget with a log-only catch, leaving the originally diagnosed "dead-but-reported-enabled" failure mode partially open when bot.start rejects during the polling-startup window before onStart fires.
- Test coverage for the rejecting bot.start path: T1-T7 covered bot.init rejection (T4) and the no-hang condition with a never-resolving bot.start (T5), but never a rejecting bot.start.
- Test/code shape mismatch on the unauthorized reply: design used ctx.reply, T1 asserted bot.api.sendMessage, and the existing dispatch helper at [src/server/telegram-bot.test.ts L94-L98](../../../../src/server/telegram-bot.test.ts#L94-L98) passes a ctx with no reply method.

## 2. Refined startup contract

The original issue ([../G47-telegram-bot-auth-and-startup-issues.md](../G47-telegram-bot-auth-and-startup-issues.md)) asks that startup failures from bot.start reject back to the caller. The grammy long-polling lifecycle has two distinguishable phases:

1. **Validation + first poll setup** — bot.init runs getMe; bot.start opens the first long-poll request. Failures here (invalid token, 401, DNS, refused connection) are *startup* failures and must reject startTelegramBot.
2. **Steady-state polling** — once onStart has fired, polling is alive. A later rejection (revoked token at runtime, network partition) is a *runtime* failure: startTelegramBot has already returned a stop handle to the caller, so the only safe surface is log + bot.catch.

The round-1 design conflated these phases by treating every bot.start rejection as runtime. Round 2 separates them with a readiness handoff:

```ts
await bot.init();                                  // phase-1a: validate token
await new Promise<void>((resolve, reject) => {     // phase-1b: wait for first poll
  let started = false;
  bot.start({
    onStart: (botInfo) => {
      started = true;
      log.info(`[telegram] Long polling started: @${botInfo.username}`);
      resolve();
    },
  }).catch((err) => {
    if (!started) reject(err);
    else log.error(`[telegram] Polling stopped with error: ${err instanceof Error ? err.message : err}`);
  });
});
```

Properties:

- bot.start rejection *before* onStart → startTelegramBot rejects. The existing [src/server/cli.ts L330-L339](../../../../src/server/cli.ts#L330-L339) try/catch already handles propagation.
- bot.start rejection *after* onStart → log-only. The caller already holds a stop handle and observed a successful startup.
- bot.start never rejects, never fires onStart → startTelegramBot hangs forever. Acceptable: this matches the pre-existing semantics (no timeout was promised by the issue) and is what the caller would want during a slow first poll. Operators time out via process supervision, not in-process. T5 documents this explicitly.

## 3. Test/code shape alignment — unauthorized reply

The round-1 design picked ctx.reply for the denial message ([02-design-r1.md §3.2](02-design-r1.md)). That stays — ctx.reply is the grammy-idiomatic way to respond to the current update and avoids re-deriving the chatId from ctx.chat.id. The test plan must therefore:

- Give the dispatch helper a per-call ctx with `reply: vi.fn().mockResolvedValue(undefined)`.
- Assert `ctx.reply` was called with `("Not authorized.", { link_preview_options: { is_disabled: true } })`.
- Leave bot.api.sendMessage assertions for the /subscribe and /unsubscribe confirmation paths (which legitimately use bot.api.sendMessage because they fire outside the inbound update context, in the persisted-subscription confirmation flow).

This is purely a test-side change; no production code drift.

## 4. Hardcoded-value compliance — precise statement

Round-2 design intentionally introduces three fixed user-visible strings: the literal denial `Not authorized.`, the confirmation `Subscribed to project notifications.` (pre-existing), and the dropped-subscription operator log message. These are bot copy, not behavioural thresholds; the project rule against hardcoded values targets tunables (timeouts, sizes, model names), which this change does not introduce. Round 2 states this explicitly rather than claiming "no new literals" ([04-review-r1.md finding 4](04-review-r1.md)).

## 5. Scope (unchanged from r1)

- **In scope**: [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts), [src/types.ts](../../../../src/types.ts#L82-L86), [src/server/telegram-bot.test.ts](../../../../src/server/telegram-bot.test.ts).
- **Out of scope**: WebSocket auth (G40), markdown-to-MarkdownV2 conversion, telegram allowlist config shape.
- **Backward-compat policy**: schema rewrite stays — `{ chatIds: number[] }` → `{ entries: { chatId, userId, subscribedAt }[] }` with no migration shim.
