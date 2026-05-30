# G47 — Design (Round 2)

- **Analysis**: [01-analysis-r2.md](01-analysis-r2.md)
- **Round 1**: [02-design-r1.md](02-design-r1.md)
- **Round 1 review**: [04-review-r1.md](04-review-r1.md)

Carries forward Proposal A from round 1 ([02-design-r1.md §1](02-design-r1.md)) with two revisions: a readiness-handoff startup contract that propagates bot.start rejections during the polling-startup window, and an aligned ctx.reply test shape for the unauthorized denial.

## 1. Recommendation (unchanged)

Adopt Proposal A. Proposal B (cross-channel ChannelAuthorizer) remains rejected for the same reasons in [02-design-r1.md §2](02-design-r1.md).

## 2. Authorization helper, inbound gate, schema rewrite, hydration filter, /subscribe handler

Identical to round 1: see [02-design-r1.md §3.1-§3.6](02-design-r1.md). The helper signature stays:

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

The inbound gate uses ctx.reply, not bot.api.sendMessage:

```ts
if (!isAuthorizedTelegramUser(userId, allowedUserIds)) {
  log.warn(`[telegram] Rejected message from unauthorized user ${userId}`);
  await ctx.reply("Not authorized.", {
    link_preview_options: { is_disabled: true },
  });
  return;
}
```

Rationale: ctx.reply targets the originating update without re-deriving chatId, is the grammy-idiomatic primitive for inbound responses, and keeps a single seam (ctx) for the test to assert against.

## 3. Startup: readiness-handoff (revised from r1)

Replaces [02-design-r1.md §3.7](02-design-r1.md). The startup block in [src/server/telegram-bot.ts L193-L200](../../../../src/server/telegram-bot.ts#L193-L200) becomes:

```ts
// Phase 1a: validate token, populate bot.botInfo. Rejects on invalid token / 401 / network.
await bot.init();
log.info(`[telegram] Bot validated: @${bot.botInfo.username} (${bot.botInfo.id})`);

// Phase 1b: open first long-poll. Resolve when onStart fires; reject if bot.start
// rejects before that. Runtime rejections (after onStart) are logged only.
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

Semantics:

| Event | startTelegramBot outcome |
|---|---|
| bot.init rejects (invalid token, network) | rejects with the init error |
| bot.start rejects before onStart (first-poll failure) | rejects with the start error |
| onStart fires; later bot.start rejection | already resolved; later rejection logged via log.error |
| onStart fires; polling stays alive | resolves with `{ stop }` |

The existing [src/server/cli.ts L330-L339](../../../../src/server/cli.ts#L330-L339) try/catch in the caller already converts a rejected startTelegramBot into "Telegram bot failed to start: …" plus continued server operation, so the operator-visible behaviour is correct for both rejection paths. The pre-existing `bot.catch(...)` handler ([telegram-bot.ts L180-L182](../../../../src/server/telegram-bot.ts#L180-L182)) continues to handle per-update errors and stays unchanged.

## 4. Test-mock shape (revised from r1)

The round-1 test plan (T1, adjusted test #3) asserted bot.api.sendMessage for the denial, but the production design uses ctx.reply ([§2](#2-authorization-helper-inbound-gate-schema-rewrite-hydration-filter-subscribe-handler)). The shipping shape:

### 4.1 Dispatch ctx now carries reply

The dispatch helper at [src/server/telegram-bot.test.ts L94-L98](../../../../src/server/telegram-bot.test.ts#L94-L98) is widened so each dispatched ctx exposes a `reply: vi.fn().mockResolvedValue(undefined)`, returned to the caller so individual tests can assert against it:

```ts
function dispatch(text: string, chatId: number, userId: number) {
  const handler = botInstances[botInstances.length - 1].handlers
    .find((h) => h.event === "message:text");
  if (!handler) throw new Error("no message:text handler registered");
  const reply = vi.fn().mockResolvedValue(undefined);
  const ctx = { chat: { id: chatId }, from: { id: userId }, message: { text }, reply };
  return { promise: handler.fn(ctx), reply };
}
```

Per-test usage:

```ts
const { promise, reply } = dispatch("hello", 100, 999);
await promise;
expect(reply).toHaveBeenCalledWith("Not authorized.", {
  link_preview_options: { is_disabled: true },
});
```

### 4.2 grammy mock exposes init + start as distinct vi.fn

The class-shaped grammy mock at [src/server/telegram-bot.test.ts L31-L57](../../../../src/server/telegram-bot.test.ts#L31-L57) is restructured so each Bot instance pushes vi.fn-backed `init`, `start`, `stop`, `catch` into `botInstances[i]`. This lets a test override per-instance behaviour (T4 makes init reject; T5/T8 make start resolve/reject) without polluting other tests:

```ts
vi.mock("grammy", () => {
  class Bot {
    public api: { sendMessage: ReturnType<typeof vi.fn> };
    public handlers: { event: string; fn: MessageHandler }[] = [];
    public botInfo = { id: 1, username: "saivage_test_bot" };
    constructor(_token: string) {
      this.api = { sendMessage: vi.fn().mockResolvedValue(undefined) };
      const inst = {
        handlers: this.handlers,
        sendMessage: this.api.sendMessage,
        // Defaults — tests override before importBot().
        init: vi.fn().mockResolvedValue(undefined),
        start: vi.fn((opts: { onStart?: (info: { username: string; id: number }) => void }) => {
          opts.onStart?.({ username: "saivage_test_bot", id: 1 });
          return new Promise<void>(() => { /* steady-state: never resolves */ });
        }),
        stop: vi.fn().mockResolvedValue(undefined),
        catch: vi.fn(),
      };
      botInstances.push(inst);
      (this as unknown as { _inst: typeof inst })._inst = inst;
    }
    on(event: string, fn: MessageHandler) {
      this.handlers.push({ event, fn });
      return this;
    }
    catch(fn: unknown) {
      (this as unknown as { _inst: { catch: ReturnType<typeof vi.fn> } })._inst.catch(fn);
      return this;
    }
    init() {
      return (this as unknown as { _inst: { init: ReturnType<typeof vi.fn> } })._inst.init();
    }
    start(opts: unknown) {
      return (this as unknown as { _inst: { start: ReturnType<typeof vi.fn> } })._inst.start(opts);
    }
    async stop() {
      await (this as unknown as { _inst: { stop: ReturnType<typeof vi.fn> } })._inst.stop();
    }
  }
  return { Bot };
});
```

Default `start` resolves the readiness promise via onStart and returns a never-resolving promise (the "steady-state" lie that real polling tells the caller). T8 overrides this with a rejecting promise *before* onStart to exercise the new rejection path.

To allow per-test override before the production code constructs the Bot, tests must register the override factory before `importBot()` is awaited. Since the module re-uses `botInstances[botInstances.length - 1]` post-construction, the simplest pattern is: capture a mutable `nextStart` / `nextInit` in module scope of the test file, queried by the mock constructor:

```ts
let nextInitBehaviour: (() => Promise<void>) | null = null;
let nextStartBehaviour: ((opts: { onStart?: (i: { username: string; id: number }) => void }) => Promise<void>) | null = null;

// inside constructor:
init: vi.fn(() => (nextInitBehaviour ?? (() => Promise.resolve()))()),
start: vi.fn((opts) => (nextStartBehaviour ?? defaultStart)(opts)),
```

Cleared in `beforeEach`.

## 5. Hardcoded-value compliance (precise statement)

Round 2 introduces three fixed user-visible strings:

- `Not authorized.` — denial copy for the inbound gate.
- `Subscribed to project notifications.` / `Unsubscribed from project notifications.` / `Already subscribed.` / `Not subscribed.` — pre-existing, unchanged in this round.
- The dropped-subscription operator log line in [02-design-r1.md §3.4](02-design-r1.md).

These are bot/log copy, not behavioural tunables. The project rule against hardcoded values targets timeouts, sizes, model identifiers, and similar parameters; none of those are introduced. No configuration-shaped value is added.

## 6. Files touched (delta from r1)

| File | Change vs. r1 |
|---|---|
| [src/server/telegram-bot.ts](../../../../src/server/telegram-bot.ts#L193-L200) | Startup block uses readiness-handoff Promise wrapper instead of fire-and-forget catch. |
| [src/server/telegram-bot.test.ts](../../../../src/server/telegram-bot.test.ts) | grammy mock exposes init + start as distinct vi.fn with per-test override hooks; dispatch helper returns ctx.reply for assertion. New test T8 (see plan). |

All other items from [02-design-r1.md §4](02-design-r1.md) are unchanged.

## 7. Compliance with project rules (delta)

- **Architecture-first / no backward compat**: unchanged from r1 — schema rewrite, no shim.
- **No regex for user-intent parsing**: unchanged.
- **Avoid hardcoded values**: clarified in §5; the round adds bot copy, no tunables.
- **Avoid over-engineering**: the readiness-handoff is a 10-line inline Promise wrapper, not a new module or abstract type. No DI introduced.
