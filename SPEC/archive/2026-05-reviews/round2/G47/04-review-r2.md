# G47 - Review r2

## Findings

1. Medium - The readiness handoff still treats `onStart` as proof that the first poll succeeded.

   Round 2 correctly wraps `bot.start` so a rejection before `onStart` rejects `startTelegramBot` ([02-design-r2.md](02-design-r2.md#L51-L69), [03-plan-r2.md](03-plan-r2.md#L18-L20)). That satisfies the narrow pre-`onStart` case. The remaining problem is that the analysis and plan describe this boundary as "first poll setup" / "open first long-poll" and say the pre-`onStart` rejection models failure before the first poll succeeds ([01-analysis-r2.md](01-analysis-r2.md#L21-L28), [02-design-r2.md](02-design-r2.md#L51-L52), [03-plan-r2.md](03-plan-r2.md#L59-L60)). The installed grammY contract does not support that: `onStart` is invoked after setup and "immediately before the first updates are being fetched" ([../../../../node_modules/grammy/out/bot.d.ts](../../../../node_modules/grammy/out/bot.d.ts#L42-L50)), and the implementation calls `onStart` before `// Start polling` / `await this.loop(options)` ([../../../../node_modules/grammy/out/bot.js](../../../../node_modules/grammy/out/bot.js#L300-L315)).

   As a result, a first `getUpdates` rejection can happen after `onStart`. Round 2's T8a then explicitly requires that a post-`onStart` `bot.start` rejection does not reject `startTelegramBot` ([03-plan-r2.md](03-plan-r2.md#L72-L73)), which can preserve the original dead-but-reported-started shape for first-poll failures such as a polling conflict. The round should either narrow the stated contract to "pre-poll setup failures before `onStart`" and explicitly accept the first-poll gap, or implement/test a true first-poll readiness/error handoff rather than using `onStart` as that boundary.

## What Looks Correct

- The Promise wrapper itself handles the requested pre-`onStart` `bot.start` rejection: while `started` is false, the catch path rejects the readiness promise.
- T8, T8a, and T8b now cover the relevant rejection branches in the proposed contract: pre-`onStart` `bot.start` rejection, post-`onStart` `bot.start` rejection, and `bot.init` rejection before `bot.start` ([03-plan-r2.md](03-plan-r2.md#L59-L76), [03-plan-r2.md](03-plan-r2.md#L105-L107)).
- The mock-fidelity test is now specified and checks the production surface used by `telegram-bot.ts`: `init`, `start`, `stop`, `botInfo`, `api.sendMessage`, `on`, and `catch` ([03-plan-r2.md](03-plan-r2.md#L78-L79)).
- The unauthorized-denial path is now aligned on `ctx.reply`: production design uses `ctx.reply`, the dispatch helper adds a `reply` mock, and T1 / adjusted test #3 assert against that mock rather than `bot.api.sendMessage` ([02-design-r2.md](02-design-r2.md#L28-L40), [02-design-r2.md](02-design-r2.md#L93-L108), [03-plan-r2.md](03-plan-r2.md#L30-L35), [03-plan-r2.md](03-plan-r2.md#L108-L109)).
- The hardcoded-value compliance note is now precise that the denial text and log copy are fixed bot/operator copy rather than tunable configuration.

## Required Revision

Revise the startup section and tests so they no longer conflate `onStart` with a successful first polling request. If the intended fix is only pre-`onStart` setup failure propagation, say that plainly and adjust the analysis/done criteria. If G47 is meant to guarantee that first-poll `bot.start` failures reject the caller, add a different readiness signal and a regression test that fails when the first polling loop rejects after `onStart`.

VERDICT: CHANGES_REQUESTED