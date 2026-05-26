# G47 — Plan (Round 2)

- **Analysis**: [01-analysis-r2.md](01-analysis-r2.md)
- **Design**: [02-design-r2.md](02-design-r2.md)
- **Round 1**: [03-plan-r1.md](03-plan-r1.md)
- **Round 1 review**: [04-review-r1.md](04-review-r1.md)

## 1. Sequenced steps (delta from r1)

Steps 1-5 of [03-plan-r1.md §1](03-plan-r1.md) are carried forward unchanged (schema rewrite in [src/types.ts](../../../../src/types.ts#L82-L86); helper in [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts); inbound gate using ctx.reply; /subscribe and /unsubscribe consuming `entries`; hydration filter with disk rewrite on drop).

### Step 6 — Startup: readiness-handoff (revised)

Replace [src/server/telegram-bot.ts L193-L200](../../../../src/server/telegram-bot.ts#L193-L200) with the block from [02-design-r2.md §3](02-design-r2.md):

- `await bot.init();`
- `log.info` line citing bot.botInfo.
- `await new Promise<void>((resolve, reject) => { let started = false; bot.start({ onStart: ... resolve() }).catch((err) => started ? log.error(...) : reject(err)); });`

Done condition: bot.start rejection before onStart propagates out of startTelegramBot; rejection after onStart does not.

### Step 7 — Test adjustments (revised)

Edit [src/server/telegram-bot.test.ts](../../../../src/server/telegram-bot.test.ts) per [02-design-r2.md §4](02-design-r2.md):

- Restructure the grammy mock so each Bot instance carries vi.fn-backed `init`, `start`, `stop`, `catch` in `botInstances[i]` plus a `botInfo` field.
- Add module-scope `nextInitBehaviour` / `nextStartBehaviour` override slots, cleared in `beforeEach`. The Bot constructor's init/start delegate to these slots, falling back to default implementations.
- Default `start` calls `opts.onStart?.(...)` synchronously, then returns a never-resolving Promise — this models steady-state polling.
- Widen `dispatch(text, chatId, userId)` to return `{ promise, reply }` where `reply` is a `vi.fn().mockResolvedValue(undefined)` attached to the ctx.
- Update the four schema-touching existing tests to read/write `entries` (already in [03-plan-r1.md §3.1](03-plan-r1.md)).
- Rewrite T1 (was: `expect(botInstances[0].sendMessage).toHaveBeenCalledWith(100, "Not authorized.")`) to: `expect(reply).toHaveBeenCalledWith("Not authorized.", { link_preview_options: { is_disabled: true } })`.
- Adjusted existing test #3 ("/subscribe from non-allow-listed user is rejected; no persistence") additionally asserts `reply` was called with the same args (it was previously asserted via `sendMessage`).
- Add T8 (new — see §3.2).

### Step 8 — Build + lint + tests

Unchanged from r1.

## 2. Order of file edits

1. [src/types.ts](../../../../src/types.ts#L82-L86) — schema rewrite.
2. [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts) — helper, gate (ctx.reply), handlers, hydration, **revised startup block**.
3. [src/server/telegram-bot.test.ts](../../../../src/server/telegram-bot.test.ts) — restructured grammy mock, dispatch returns reply, schema updates, T1-T8.

## 3. Regression test plan (delta)

All tests in [src/server/telegram-bot.test.ts](../../../../src/server/telegram-bot.test.ts).

### 3.1 Adjusted existing tests

Same schema-shape adjustments as [03-plan-r1.md §3.1](03-plan-r1.md), with one revision:

- Adjusted test #3 — denial assertion shifts from `botInstances[0].sendMessage` to `reply` (returned by `dispatch`).

### 3.2 New regression tests

T1-T7 carry forward from [03-plan-r1.md §3.2](03-plan-r1.md) with the T1 reply-target revision noted above. New test added this round:

T8. **bot.start rejection during polling startup propagates to caller.** Set `nextStartBehaviour = (opts) => Promise.reject(new Error("polling failed: bad token"))` *before* `importBot()`. The mock must reject *without* invoking `opts.onStart` first — this models the failure mode of bot.start failing before the first poll succeeds.

Assertions:

- `await expect(startTelegramBot(runtime)).rejects.toThrowError(/polling failed: bad token/)`.
- `botInstances[0].init` was called.
- `botInstances[0].start` was called.
- The rejection is not silently swallowed: the test relies on `rejects.toThrowError` succeeding, which fails if startTelegramBot resolves or rejects with a different error.

T8 also covers the silent-swallow regression — if a future refactor reverts to `void bot.start(...)`-style fire-and-forget without readiness handoff, this test fails because startTelegramBot would resolve instead of rejecting.

Companion micro-tests under the same parent:

T8a. **bot.start rejection *after* onStart does NOT reject startTelegramBot.** Set `nextStartBehaviour = (opts) => { opts.onStart?.({ username: "ok", id: 1 }); return Promise.reject(new Error("polling died mid-stream")); }`. Assert `await startTelegramBot(runtime)` resolves to an object with a `stop` function, and that `log.error` was invoked (via a `vi.spyOn` on the imported `log` module or a captured console hook).

T8b. **bot.init rejection short-circuits before bot.start is called.** Set `nextInitBehaviour = () => Promise.reject(new Error("invalid token"))`. Assert: `startTelegramBot` rejects; `botInstances[0].start` was NOT called. This is a tightening of T4.

### 3.3 Mock-fidelity check

Add a single test "grammy mock surface mirrors production usage" that asserts the mock exposes `init`, `start`, `stop`, `botInfo`, `api.sendMessage`, `on`, `catch` — the exact surface read or invoked by [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts). This prevents mock drift if grammy's surface used by production code shifts.

### 3.4 Non-functional checks (unchanged from r1)

- `npm run build` — TypeScript compilation must succeed; `chatIds` must not remain in any consumer.
- `grep -rn 'chatIds' src/ web/` — no production-code matches.
- `npm test -- src/server/telegram-bot.test.ts` — green.
- `npm test` — full saivage suite green.

### 3.5 Manual smoke (unchanged from r1)

See [03-plan-r1.md §3.4](03-plan-r1.md).

## 4. Risks & mitigations (delta)

| Risk | Mitigation |
|---|---|
| Readiness-handoff Promise leaks if onStart never fires and bot.start never rejects. | Acceptable — matches r1 semantics; operators time out via process supervision. Documented in [01-analysis-r2.md §2](01-analysis-r2.md). |
| grammy onStart is sync-or-async — synchronous resolve inside `new Promise` callback could surprise. | Standard Promise executor pattern; resolve() is safe to call synchronously and is the canonical "deferred" idiom. |
| Test-mock per-instance override slots leak across tests. | `beforeEach` clears `nextInitBehaviour` and `nextStartBehaviour`. T8/T8a/T8b set their slot just before `importBot()`. |

Carried-forward risks from [03-plan-r1.md §4](03-plan-r1.md) remain.

## 5. Done criteria (delta)

In addition to the r1 done criteria ([03-plan-r1.md §5](03-plan-r1.md)):

- T8 passes: a rejecting bot.start before onStart propagates out of startTelegramBot.
- T8a passes: a rejecting bot.start after onStart does not reject startTelegramBot and is logged.
- T8b passes: bot.init rejection short-circuits before bot.start is invoked.
- T1 and adjusted existing test #3 assert against `ctx.reply` (not `bot.api.sendMessage`) for the unauthorized denial, matching the production call site.
- The grammy mock exposes `init`, `start`, `stop`, `botInfo`, `api.sendMessage`, `on`, `catch` as distinct vi.fn-backed entries per Bot instance.
