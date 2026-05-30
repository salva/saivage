# G47 - Review r3

## Findings

No blocking findings.

## Verification

- The round 2 objection has been addressed. Round 3 no longer claims that `onStart` proves the first `getUpdates` request succeeded; it reframes the readiness boundary as init plus grammY setup completion, with the polling loop still only about to run ([01-analysis-r3.md](01-analysis-r3.md), [02-design-r3.md](02-design-r3.md), [03-plan-r3.md](03-plan-r3.md)).
- The live grammY implementation supports that framing: `bot.start` awaits setup, including `deleteWebhook`, then awaits `options.onStart`, then runs `validateAllowedUpdates`, and only after that calls `await this.loop(options)` ([../../../../node_modules/grammy/out/bot.js](../../../../node_modules/grammy/out/bot.js#L298-L316)). The typed contract also says `onStart` is executed immediately before the first updates are fetched ([../../../../node_modules/grammy/out/bot.d.ts](../../../../node_modules/grammy/out/bot.d.ts#L40-L52)).
- The post-`onStart` `.catch` path is now documented as the log-only handler for first-poll failures and steady-state polling failures. That matches the proposed wrapper: `started` flips inside `onStart`, so any later `bot.start` rejection reaches `log.error` rather than rejecting `startTelegramBot`.
- T8 is renamed and scoped to a rejection before `onStart`, with the mock rejecting without invoking `opts.onStart`. T8a is renamed and scoped to a rejection after `onStart`, asserts that `startTelegramBot` resolves, and asserts the rejection is logged. This directly covers the required contract split.

## Non-blocking note

One sentence in [01-analysis-r3.md](01-analysis-r3.md) says `onStart` proves "the polling loop has been entered." The surrounding text, design, plan, and live-code citations all say the more precise thing: the polling loop is about to run, and first `getUpdates` is still after `onStart`. This wording is worth tightening during implementation-doc cleanup, but it does not undermine the corrected contract.

VERDICT: APPROVED