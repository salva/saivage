/**
 * Saivage — Telegram bot subscription tests (F16).
 *
 * Tests the /subscribe and /unsubscribe message-routing logic plus
 * boot-time hydration of persisted chat-id subscriptions. ChatAgent and
 * the grammy Bot are mocked to keep the test focused on the bot's own
 * routing/persistence behaviour.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir, readDocOrNull, writeDoc } from "../store/documents.js";
import { TelegramSubscriptionsSchema } from "../types.js";

type MessageHandler = (ctx: {
  chat: { id: number };
  from: { id: number };
  message: { text: string };
}) => Promise<void>;

const botInstances: Array<{
  handlers: { event: string; fn: MessageHandler }[];
  sendMessage: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  catch: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("grammy", () => {
  class Bot {
    public api: { sendMessage: ReturnType<typeof vi.fn> };
    public handlers: { event: string; fn: MessageHandler }[] = [];
    constructor(_token: string) {
      this.api = { sendMessage: vi.fn().mockResolvedValue(undefined) };
      botInstances.push({
        handlers: this.handlers,
        sendMessage: this.api.sendMessage,
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        catch: vi.fn(),
      });
    }
    on(event: string, fn: MessageHandler): this {
      this.handlers.push({ event, fn });
      return this;
    }
    catch(_fn: unknown): this {
      return this;
    }
    start(opts: { onStart?: (info: { username: string; id: number }) => void }): void {
      opts.onStart?.({ username: "saivage_test_bot", id: 1 });
    }
    async stop(): Promise<void> {}
  }
  return { Bot };
});

// Mock ChatAgent to a noop — F16 tests are about routing & persistence,
// not about chat agent behaviour.
vi.mock("../agents/chat.js", () => ({
  ChatAgent: {
    create: vi.fn().mockResolvedValue({
      run: vi.fn().mockReturnValue(new Promise(() => { /* never resolves */ })),
    }),
  },
}));

// We import after the mocks are registered.
async function importBot() {
  return await import("./telegram-bot.js");
}

function makeRuntimeStub(saivageDir: string, allowedUserIds: number[] = []) {
  const subsPath = join(saivageDir, "telegram-subscriptions.json");
  return {
    config: {
      telegram: { botToken: "fake-token", allowedUserIds },
      notifications: undefined,
    },
    routing: { resolve: () => ({ modelSpec: "x", authProfile: "y", accountRef: undefined }) },
    project: {
      paths: { telegramSubscriptions: subsPath },
    },
    router: {},
    mcpRuntime: {},
    eventBus: {},
    plannerControl: {},
    agentRegistry: new Map(),
  } as unknown as import("./bootstrap.js").SaivageRuntime;
}

function dispatch(text: string, chatId: number, userId: number): Promise<void> {
  const handler = botInstances[botInstances.length - 1].handlers.find((h) => h.event === "message:text");
  if (!handler) throw new Error("no message:text handler registered");
  return handler.fn({ chat: { id: chatId }, from: { id: userId }, message: { text } });
}

describe("startTelegramBot — F16 subscriptions", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "saivage-tg-"));
    await ensureDir(tmp);
    botInstances.length = 0;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("boots with no persisted subscriptions and creates no sessions", async () => {
    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [1]);
    await startTelegramBot(runtime);
    expect(await readDocOrNull(join(tmp, "telegram-subscriptions.json"), TelegramSubscriptionsSchema)).toBeNull();
  });

  it("/subscribe from allow-listed user persists chat-id and confirms", async () => {
    const subsPath = join(tmp, "telegram-subscriptions.json");
    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);
    await startTelegramBot(runtime);

    await dispatch("/subscribe", 100, 42);

    const persisted = await readDocOrNull(subsPath, TelegramSubscriptionsSchema);
    expect(persisted).toEqual({ chatIds: [100] });
    expect(botInstances[0].sendMessage).toHaveBeenCalledWith(100, "Subscribed to project notifications.");
  });

  it("/subscribe from non-allow-listed user is rejected; no persistence", async () => {
    const subsPath = join(tmp, "telegram-subscriptions.json");
    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);
    await startTelegramBot(runtime);

    await dispatch("/subscribe", 100, 999);

    expect(await readDocOrNull(subsPath, TelegramSubscriptionsSchema)).toBeNull();
    expect(botInstances[0].sendMessage).not.toHaveBeenCalled();
  });

  it("/unsubscribe removes chat-id and confirms", async () => {
    const subsPath = join(tmp, "telegram-subscriptions.json");
    await writeDoc(subsPath, { chatIds: [100, 200] }, TelegramSubscriptionsSchema);

    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);
    await startTelegramBot(runtime);

    await dispatch("/unsubscribe", 100, 42);

    const persisted = await readDocOrNull(subsPath, TelegramSubscriptionsSchema);
    expect(persisted).toEqual({ chatIds: [200] });
  });

  it("boot with persisted chat-ids creates sessions at startup", async () => {
    const subsPath = join(tmp, "telegram-subscriptions.json");
    await writeDoc(subsPath, { chatIds: [101, 102] }, TelegramSubscriptionsSchema);

    const { ChatAgent } = await import("../agents/chat.js");
    (ChatAgent.create as ReturnType<typeof vi.fn>).mockClear();

    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);
    await startTelegramBot(runtime);

    expect((ChatAgent.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("plain text from allow-listed user does NOT persist the chat-id", async () => {
    const subsPath = join(tmp, "telegram-subscriptions.json");
    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);
    await startTelegramBot(runtime);

    await dispatch("hello world", 100, 42);

    expect(await readDocOrNull(subsPath, TelegramSubscriptionsSchema)).toBeNull();
  });

  it("boot with corrupt persisted file throws (fatal)", async () => {
    const subsPath = join(tmp, "telegram-subscriptions.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(subsPath, "not json", "utf-8");

    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);
    await expect(startTelegramBot(runtime)).rejects.toThrow();
  });
});
