# G47 - Review r1

## Findings

1. Medium - The startup fix does not actually close the diagnosed dead-but-reported-enabled failure mode.

   The analysis correctly says the bug is that startTelegramBot can resolve successfully while bot.start is already rejecting, leaving the caller unable to distinguish alive from dead ([01-analysis-r1.md](SPEC/v2/review-2026-05-round2/G47/01-analysis-r1.md#L12), [01-analysis-r1.md](SPEC/v2/review-2026-05-round2/G47/01-analysis-r1.md#L32)). The issue also asks startup failures from bot.start to reject back to the caller ([G47-telegram-bot-auth-and-startup-issues.md](SPEC/v2/review-2026-05-round2/G47-telegram-bot-auth-and-startup-issues.md#L95-L97)). The design instead changes the contract to await bot.init and then run bot.start as fire-and-forget with a catch ([02-design-r1.md](SPEC/v2/review-2026-05-round2/G47/02-design-r1.md#L12), [02-design-r1.md](SPEC/v2/review-2026-05-round2/G47/02-design-r1.md#L173-L186)), and the plan makes that the done criterion ([03-plan-r1.md](SPEC/v2/review-2026-05-round2/G47/03-plan-r1.md#L34-L40), [03-plan-r1.md](SPEC/v2/review-2026-05-round2/G47/03-plan-r1.md#L119)). That catches invalid-token/getMe validation, but a long-polling failure after init still becomes a log-only background failure after startTelegramBot has returned a stop handle. Round 2 needs either a readiness/error handoff for bot.start, for example propagating rejection before onStart, or an explicit narrowed diagnosis that proves bot.init is the only startup contract G47 intends to guarantee.

2. Medium - The T1-T7 tests do not cover the bot.start failure path they are meant to protect.

   T4 only proves bot.init rejection propagates, and T5 asserts startTelegramBot resolves while bot.start remains pending ([03-plan-r1.md](SPEC/v2/review-2026-05-round2/G47/03-plan-r1.md#L84-L86)). There is no test where bot.start rejects before or during polling startup, no assertion that such a rejection reaches the caller when it should, and no assertion that the fire-and-forget catch at least logs and tears down channel state if the design deliberately keeps it non-fatal. That leaves the original unawaited-start regression unguarded even though the current live code really does discard bot.start's return value ([src/server/telegram-bot.ts](src/server/telegram-bot.ts#L195-L200)). Add a regression test that exercises a rejecting bot.start promise and align it with the chosen startup contract.

3. Low - The unauthorized-reply test plan does not match the proposed production call site.

   The design and step plan use ctx.reply for the unauthorized response ([02-design-r1.md](SPEC/v2/review-2026-05-round2/G47/02-design-r1.md#L74-L80), [03-plan-r1.md](SPEC/v2/review-2026-05-round2/G47/03-plan-r1.md#L24-L25)), but the adjusted test and T1 expect botInstances[0].api.sendMessage to be called ([03-plan-r1.md](SPEC/v2/review-2026-05-round2/G47/03-plan-r1.md#L70-L82)). The existing test dispatch context has no reply method ([src/server/telegram-bot.test.ts](src/server/telegram-bot.test.ts#L16-L20), [src/server/telegram-bot.test.ts](src/server/telegram-bot.test.ts#L87-L91)), so the test plan either needs to mock ctx.reply and assert that directly, or the implementation should use bot.api.sendMessage consistently.

4. Low - The hardcoded-value compliance note is too absolute.

   The compliance sections say no new hardcoded values are introduced ([01-analysis-r1.md](SPEC/v2/review-2026-05-round2/G47/01-analysis-r1.md#L49), [02-design-r1.md](SPEC/v2/review-2026-05-round2/G47/02-design-r1.md#L207)), while the design adds the fixed user-visible reply Not authorized. and the dropped-subscription warning text. That may be acceptable as ordinary bot copy, especially because the issue asks for a visible one-line denial, but the round should say that explicitly instead of claiming there are no new literals.

## What Looks Correct

- The three original defects are correctly diagnosed: silent unauthorized drop in the inbound gate, unawaited bot.start, and boot hydration over persisted chatIds without an allowedUserIds check. These match the live code in [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L137-L140), [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L190-L191), and [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L195-L200).
- The persistence rewrite is architecture-first: replacing chatIds with entries carrying chatId, userId, and subscribedAt, with no migration shim or dual-read path, matches the workspace's no-backward-compat rule ([02-design-r1.md](SPEC/v2/review-2026-05-round2/G47/02-design-r1.md#L13-L14), [02-design-r1.md](SPEC/v2/review-2026-05-round2/G47/02-design-r1.md#L85-L102)).
- The inbound command parsing remains literal slash-command handling with exact /subscribe and /unsubscribe checks plus literal startsWith continuations, not regex-based user-intent parsing ([01-analysis-r1.md](SPEC/v2/review-2026-05-round2/G47/01-analysis-r1.md#L48), [02-design-r1.md](SPEC/v2/review-2026-05-round2/G47/02-design-r1.md#L133-L149)).
- Rejecting Proposal B is sound. The WebSocket gate is a capability-token check through SAIVAGE_API_TOKEN, while Telegram is an identity allowlist with persisted push destinations; the round correctly avoids a leaky tagged-union authorizer that would broaden G47 into G40 territory ([01-analysis-r1.md](SPEC/v2/review-2026-05-round2/G47/01-analysis-r1.md#L39-L42), [02-design-r1.md](SPEC/v2/review-2026-05-round2/G47/02-design-r1.md#L25-L45), [src/server/server.ts](src/server/server.ts#L59-L76), [src/server/server.ts](src/server/server.ts#L663-L666)).
- There is no fragile agent-tool-call heuristic in the proposal. The changes stay inside Telegram auth, subscription persistence, and Telegram bot startup.

## Required Revision

Round 2 should tighten the startup contract so bot.start failures are not reduced to a background log after startTelegramBot has reported success, then update T1-T7 to test that contract directly. While editing, align the unauthorized-reply mock/assertion with ctx.reply versus bot.api.sendMessage and make the hardcoded-value compliance note precise about the intentionally fixed denial copy.

VERDICT: CHANGES_REQUESTED