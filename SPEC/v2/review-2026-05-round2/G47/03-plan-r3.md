# G47 — Plan (Round 3)

- **Analysis**: [01-analysis-r3.md](01-analysis-r3.md)
- **Design**: [02-design-r3.md](02-design-r3.md)
- **Round 2**: [03-plan-r2.md](03-plan-r2.md)
- **Round 2 review**: [04-review-r2.md](04-review-r2.md)

## 1. Sequenced steps (delta from r2)

Steps 1-5 of [03-plan-r2.md §1](03-plan-r2.md) carry forward unchanged (schema rewrite in [src/types.ts](../../../../src/types.ts#L82-L86); helper in [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts); inbound gate using ctx.reply; /subscribe and /unsubscribe consuming `entries`; hydration filter with disk rewrite on drop).

### Step 6 — Startup: readiness-handoff with reframed contract

Identical production code to [03-plan-r2.md §1 step 6](03-plan-r2.md). One textual change: the inline comment above the `new Promise` wrapper in [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts) reads:

```
// Phase 1b: open grammY long polling. Resolve when onStart fires (= init + setup
// complete, polling loop about to run). Reject only if bot.start rejects BEFORE
// onStart. Rejections AFTER onStart (first-poll failure, runtime polling failure)
// are logged, not propagated — see SPEC G47 / 02-design-r3.md §3.1.
```

Done condition:

- `bot.start` rejection **before** `onStart` propagates out of `startTelegramBot`.
- `bot.start` rejection **after** `onStart` (which includes the first-`getUpdates` failure path) does **not** reject the caller, and is logged via `log.error`. This is the documented behaviour, not a bug.

### Step 7 — Test adjustments (delta from r2)

All mock structure and helper changes from [03-plan-r2.md §1 step 7](03-plan-r2.md) are unchanged. The deltas are:

- Rename T8 from "bot.start rejection during polling startup propagates to caller" to **"bot.start rejection BEFORE onStart propagates to caller (pre-loop setup failure)"**. The test body is unchanged: `nextStartBehaviour` rejects without calling `opts.onStart`, modelling a `deleteWebhook` retry-budget failure or signal-aborted `init`.
- Rename T8a from "bot.start rejection after onStart does NOT reject startTelegramBot" to **"bot.start rejection AFTER onStart is logged, not propagated (covers first-poll failure such as 409 polling conflict)"**. The test body is unchanged.
- T8b stays as-is.
- The mock-fidelity check stays as-is.

### Step 8 — Build + lint + tests

Unchanged from r2.

## 2. Order of file edits

Same as [03-plan-r2.md §2](03-plan-r2.md).

## 3. Regression test plan (delta)

All tests in [src/server/telegram-bot.test.ts](../../../../src/server/telegram-bot.test.ts).

### 3.1 Adjusted existing tests

Same as [03-plan-r2.md §3.1](03-plan-r2.md). No further delta.

### 3.2 New regression tests (renamed; bodies unchanged)

T8. **bot.start rejection BEFORE onStart propagates to caller (pre-loop setup failure).** Set `nextStartBehaviour = (opts) => Promise.reject(new Error("deleteWebhook failed"))` *before* `importBot()`. The mock must reject *without* invoking `opts.onStart` first — this models setup-phase failures (`deleteWebhook` retry-budget exhausted, signal-aborted `init`).

Assertions:

- `await expect(startTelegramBot(runtime)).rejects.toThrowError(/deleteWebhook failed/)`.
- `botInstances[0].init` was called.
- `botInstances[0].start` was called.
- The rejection is not silently swallowed.

T8 also covers the silent-swallow regression — if a future refactor reverts to `void bot.start(...)` without the readiness wrapper, the caller resolves and this test fails.

T8a. **bot.start rejection AFTER onStart is logged, not propagated.** Set `nextStartBehaviour = (opts) => { opts.onStart?.({ username: "ok", id: 1 }); return Promise.reject(new Error("Conflict: terminated by other getUpdates")); }`. This models the documented first-`getUpdates` 409-conflict failure path and any later steady-state rejection.

Assertions:

- `await startTelegramBot(runtime)` resolves to an object with a `stop` function.
- `log.error` was invoked with a message containing the rejection text (via `vi.spyOn` on the imported `log` module).
- The startTelegramBot promise does **not** reject.

Comment in the test source must reference the contract row in [02-design-r3.md §3.1](02-design-r3.md) so a future reader understands this is the documented gap, not a bug.

T8b. **bot.init rejection short-circuits before bot.start is called.** Unchanged from r2 ([03-plan-r2.md §3.2](03-plan-r2.md)).

### 3.3 Mock-fidelity check

Unchanged from [03-plan-r2.md §3.3](03-plan-r2.md).

### 3.4 Non-functional checks

Unchanged from [03-plan-r2.md §3.4](03-plan-r2.md).

### 3.5 Manual smoke

Unchanged from [03-plan-r2.md §3.5](03-plan-r2.md), with one operator-facing note added: a `log.error("[telegram] Polling stopped with error: ...")` line with no preceding `Long polling started` log indicates a pre-`onStart` rejection (T8 path) and is also surfaced by [src/server/cli.ts L330-L339](../../../../src/server/cli.ts#L330-L339) as "Telegram bot failed to start: ...". A `Polling stopped with error: ...` line *after* a `Long polling started: ...` line indicates the documented post-`onStart` path (T8a; typically a 409 conflict) and is expected behaviour — investigate deployment topology, not startup code.

## 4. Risks & mitigations (delta)

| Risk | Mitigation |
|---|---|
| Operators interpret a `Polling stopped with error: 409 Conflict` log line as "startup succeeded → bot is alive" because startTelegramBot returned a stop handle. | Documented in §3.5 and in [02-design-r3.md §3.1](02-design-r3.md). The log line is `log.error`, so it surfaces in standard log queries. Accepted gap — see [01-analysis-r3.md §3](01-analysis-r3.md). |
| Future contributor "fixes" T8a by making startTelegramBot reject on post-onStart rejection, breaking the documented contract. | T8a's body asserts `startTelegramBot resolves`; the inline comment cites the contract row. |
| Future grammY upgrade changes `onStart` timing (e.g. moves it after the first `getUpdates`). | Mock-fidelity check (§3.3) still passes by surface, but the contract row in [02-design-r3.md §3.1](02-design-r3.md) would silently become inaccurate. Mitigation: when bumping grammy in [package.json](../../../../package.json), reread [02-design-r3.md §3.1](02-design-r3.md) against the new `node_modules/grammy/out/bot.js` start() body. No automated check; the design pins specific bot.js line ranges so a future audit can diff. |

Carried-forward risks from [03-plan-r2.md §4](03-plan-r2.md) remain.

## 5. Done criteria (delta)

In addition to the r2 done criteria ([03-plan-r2.md §5](03-plan-r2.md)):

- The startup-block inline comment in [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts) explicitly states that post-`onStart` rejections are logged, not propagated, and references SPEC G47 r3.
- T8 (renamed) passes: a pre-`onStart` bot.start rejection propagates.
- T8a (renamed) passes: a post-`onStart` bot.start rejection is logged via `log.error` and does **not** reject `startTelegramBot`. Its test source carries a comment citing [02-design-r3.md §3.1](02-design-r3.md) so a reader knows this is the documented first-poll-failure path.
- T8b passes: unchanged from r2.
- No production behaviour change vs r2; this round is documentation + test-name correctness.
