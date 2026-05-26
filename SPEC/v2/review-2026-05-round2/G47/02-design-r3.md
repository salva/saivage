# G47 — Design (Round 3)

- **Analysis**: [01-analysis-r3.md](01-analysis-r3.md)
- **Round 2**: [02-design-r2.md](02-design-r2.md)
- **Round 2 review**: [04-review-r2.md](04-review-r2.md)

Carries forward Proposal A and every concrete code shape from [02-design-r2.md](02-design-r2.md). The only delta is **how the startup-readiness contract is documented**: round 2 framed `onStart` as proof the first poll succeeded; round 3 reframes it as proof of init + grammY polling-start, with first-poll-and-beyond failures explicitly handled by the post-`onStart` log arm. See [01-analysis-r3.md §2-§4](01-analysis-r3.md).

## 1. Recommendation (unchanged)

Adopt Proposal A. Proposal B (cross-channel ChannelAuthorizer) remains rejected. See [02-design-r1.md §2](02-design-r1.md). Option (b) from [01-analysis-r3.md §3](01-analysis-r3.md) (waiting on first successful `getUpdates`) is also rejected; see same anchor for rationale.

## 2. Authorization helper, inbound gate, schema rewrite, hydration filter, /subscribe handler

Identical to round 2 ([02-design-r2.md §2](02-design-r2.md)). No change.

## 3. Startup: readiness-handoff (code unchanged; contract reframed)

The production code block is bit-for-bit the same as [02-design-r2.md §3](02-design-r2.md):

```ts
// Phase 1a: validate token, populate bot.botInfo. Rejects on invalid token / 401 / network.
await bot.init();
log.info(`[telegram] Bot validated: @${bot.botInfo.username} (${bot.botInfo.id})`);

// Phase 1b: open grammY long polling. Resolve when onStart fires (= init + setup complete,
// polling loop about to run). Reject only if bot.start rejects BEFORE onStart fires.
// Rejections AFTER onStart (first-poll failure, runtime polling failure) are log-only —
// see contract table below.
log.info("[telegram] Starting Telegram bot (long polling)...");
await new Promise<void>((resolve, reject) => {
  let started = false;
  bot
    .start({
      onStart: (botInfo) => {
        started = true;
        log.info(`[telegram] Long polling started: @${botInfo.username} (${botInfo.id})`);
        resolve();
      },
    })
    .catch((err) => {
      if (!started) {
        reject(err);
      } else {
        log.error(
          `[telegram] Polling stopped with error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
});
```

### 3.1 Contract (revised wording)

`onStart` is invoked by grammY after `bot.init` (when needed) and `deleteWebhook` have completed, immediately before the polling loop's first `getUpdates` ([../../../../node_modules/grammy/out/bot.d.ts](../../../../node_modules/grammy/out/bot.d.ts#L40-L52), [../../../../node_modules/grammy/out/bot.js](../../../../node_modules/grammy/out/bot.js#L295-L320)). Therefore:

| Event | onStart fired? | startTelegramBot outcome | Handler |
|---|---|---|---|
| `bot.init` rejects | no | **rejects** with the init error | caller try/catch in [src/server/cli.ts L330-L339](../../../../src/server/cli.ts#L330-L339) |
| `bot.start` rejects in setup phase (deleteWebhook retry-budget exhausted, signal-aborted init) | no | **rejects** with the start error | same caller try/catch |
| `bot.start` rejects in `this.loop` on the first `getUpdates` (e.g. 409 polling conflict) | yes | **resolves**, then later `log.error("[telegram] Polling stopped with error: ...")` | post-`onStart` log arm; caller already holds `{ stop }`; rest of server keeps running |
| `bot.start` rejects in `this.loop` after one or more successful `getUpdates` (revoked token at runtime, persistent network partition) | yes | already resolved; same `log.error` | same post-`onStart` log arm |
| `onStart` fires and polling stays alive | yes | **resolves** with `{ stop }` | normal path |

The first-poll-failure row is an **accepted, documented gap**: the readiness primitive grammY exposes (`onStart`) precedes the first `getUpdates`. Resolving this gap synchronously would require wiring production logic into an `Api` transformer to observe the first 2xx `getUpdates` response, which adds risk for one log-line of fidelity; see [01-analysis-r3.md §3](01-analysis-r3.md).

The existing `bot.catch(...)` handler at [telegram-bot.ts L180-L182](../../../../src/server/telegram-bot.ts#L180-L182) is unchanged. It only handles middleware errors per-update and never sees polling-loop transport rejections, so it is not part of this contract.

## 4. Test-mock shape (unchanged)

Identical to [02-design-r2.md §4](02-design-r2.md). The per-instance `init` / `start` / `stop` / `catch` vi.fn surface, the `nextInitBehaviour` / `nextStartBehaviour` module-scope override slots, and the `dispatch` helper returning `{ promise, reply }` all carry forward verbatim.

The only test-side change in r3 is the **renaming of T8 / T8a** to reflect the corrected contract; see [03-plan-r3.md §3.2](03-plan-r3.md).

## 5. Hardcoded-value compliance

Unchanged from [02-design-r2.md §5](02-design-r2.md).

## 6. Files touched (delta from r2)

| File | Change vs. r2 |
|---|---|
| [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts#L193-L200) | **No code delta** beyond r2. Inline comment on the readiness wrapper says "first-poll failures are logged, not propagated — see SPEC G47". |
| [src/server/telegram-bot.test.ts](../../../../src/server/telegram-bot.test.ts) | Test renames (T8 / T8a). No structural change. |

All other items from [02-design-r2.md §6](02-design-r2.md) are unchanged.

## 7. Compliance with project rules (delta)

- **Architecture-first / no backward compat**: unchanged — schema rewrite, no shim.
- **No regex for user-intent parsing**: unchanged.
- **Avoid hardcoded values**: unchanged.
- **Avoid over-engineering**: r3 explicitly rejects option (b) (instrumenting an `Api` transformer for first-`getUpdates`-success readiness) under this rule. The readiness handoff stays as a 10-line inline Promise wrapper.
