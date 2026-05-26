/**
 * Saivage — Telegram bot subscription tests.
 *
 * Tests /subscribe and /unsubscribe routing, persisted subscription
 * hydration, authorization, and grammY long-polling startup handoff.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir, readDocOrNull, writeDoc } from "../store/documents.js";
import { TelegramSubscriptionsSchema } from "../types.js";
import { NoteManager } from "../runtime/notes.js";
import { log } from "../log.js";

type MessageHandler = (ctx: {
  chat: { id: number };
  from?: { id: number };
  message: { text: string };
  reply: ReturnType<typeof vi.fn>;
}) => Promise<void>;

type StartOptions = { onStart?: (info: { username: string; id: number }) => void };
type InitBehaviour = () => Promise<void>;
type StartBehaviour = (opts: StartOptions) => Promise<void>;

const botInstances: Array<{
  handlers: { event: string; fn: MessageHandler }[];
  sendMessage: ReturnType<typeof vi.fn>;
  init: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  catch: ReturnType<typeof vi.fn>;
  botInfo: { username: string; id: number };
}> = [];

let nextInitBehaviour: InitBehaviour | null = null;
let nextStartBehaviour: StartBehaviour | null = null;

vi.mock("grammy", () => {
  class Bot {
    public api: { sendMessage: ReturnType<typeof vi.fn> };
    public handlers: { event: string; fn: MessageHandler }[] = [];
    public botInfo = { username: "saivage_test_bot", id: 1 };
    public init: ReturnType<typeof vi.fn>;
    public start: ReturnType<typeof vi.fn>;
    public stop: ReturnType<typeof vi.fn>;
    public catch: ReturnType<typeof vi.fn>;

    constructor(_token: string) {
      this.api = { sendMessage: vi.fn().mockResolvedValue(undefined) };
      this.init = vi.fn(async () => {
        if (nextInitBehaviour) return await nextInitBehaviour();
      });
      this.start = vi.fn((opts: StartOptions) => {
        if (nextStartBehaviour) return nextStartBehaviour(opts);
        opts.onStart?.(this.botInfo);
        return new Promise<void>(() => { /* steady-state polling */ });
      });
      this.stop = vi.fn().mockResolvedValue(undefined);
      this.catch = vi.fn().mockReturnValue(this);
      botInstances.push({
        handlers: this.handlers,
        sendMessage: this.api.sendMessage,
        init: this.init,
        start: this.start,
        stop: this.stop,
        catch: this.catch,
        botInfo: this.botInfo,
      });
    }

    on(event: string, fn: MessageHandler): this {
      this.handlers.push({ event, fn });
      return this;
    }
  }
  return { Bot };
});

vi.mock("../agents/chat.js", () => ({
  ChatAgent: {
    create: vi.fn().mockResolvedValue({
      run: vi.fn().mockReturnValue(new Promise(() => { /* never resolves */ })),
    }),
  },
}));

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
      paths: {
        telegramSubscriptions: subsPath,
        notes: join(saivageDir, "notes"),
      },
    },
    router: {},
    mcpRuntime: {},
    noteManager: new NoteManager(join(saivageDir, "notes")),
    eventBus: {},
    plannerControl: {},
    agentRegistry: new Map(),
  } as unknown as import("./bootstrap.js").SaivageRuntime;
}

function dispatch(text: string, chatId: number, userId: number | undefined): {
  promise: Promise<void>;
  reply: ReturnType<typeof vi.fn>;
} {
  const handler = botInstances[botInstances.length - 1].handlers.find((h) => h.event === "message:text");
  if (!handler) throw new Error("no message:text handler registered");
  const reply = vi.fn().mockResolvedValue(undefined);
  return {
    promise: handler.fn({
      chat: { id: chatId },
      from: userId === undefined ? undefined : { id: userId },
      message: { text },
      reply,
    }),
    reply,
  };
}

describe("startTelegramBot subscriptions", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "saivage-tg-"));
    await ensureDir(tmp);
    botInstances.length = 0;
    nextInitBehaviour = null;
    nextStartBehaviour = null;
    vi.restoreAllMocks();
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

  it("/subscribe from allow-listed user persists chat and user id and confirms", async () => {
    const subsPath = join(tmp, "telegram-subscriptions.json");
    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);
    await startTelegramBot(runtime);

    await dispatch("/subscribe", 100, 42).promise;

    const persisted = await readDocOrNull(subsPath, TelegramSubscriptionsSchema);
    expect(persisted).toEqual({
      entries: [{ chatId: 100, userId: 42, subscribedAt: expect.stringMatching(/^\d{4}-/) }],
    });
    expect(botInstances[0].sendMessage).toHaveBeenCalledWith(100, "Subscribed to project notifications.");
  });

  it("/subscribe from non-allow-listed user is rejected with an in-channel reply", async () => {
    const subsPath = join(tmp, "telegram-subscriptions.json");
    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);
    await startTelegramBot(runtime);

    const { promise, reply } = dispatch("/subscribe", 100, 999);
    await promise;

    expect(await readDocOrNull(subsPath, TelegramSubscriptionsSchema)).toBeNull();
    expect(botInstances[0].sendMessage).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith("Not authorized.", {
      link_preview_options: { is_disabled: true },
    });
  });

  it("/unsubscribe removes chat and confirms", async () => {
    const subsPath = join(tmp, "telegram-subscriptions.json");
    await writeDoc(subsPath, {
      entries: [
        { chatId: 100, userId: 42, subscribedAt: "2026-01-01T00:00:00.000Z" },
        { chatId: 200, userId: 42, subscribedAt: "2026-01-01T00:00:00.000Z" },
      ],
    }, TelegramSubscriptionsSchema);

    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);
    await startTelegramBot(runtime);

    await dispatch("/unsubscribe", 100, 42).promise;

    const persisted = await readDocOrNull(subsPath, TelegramSubscriptionsSchema);
    expect(persisted).toEqual({
      entries: [{ chatId: 200, userId: 42, subscribedAt: "2026-01-01T00:00:00.000Z" }],
    });
  });

  it("boot with persisted allowed entries creates sessions at startup", async () => {
    const subsPath = join(tmp, "telegram-subscriptions.json");
    await writeDoc(subsPath, {
      entries: [
        { chatId: 101, userId: 42, subscribedAt: "2026-01-01T00:00:00.000Z" },
        { chatId: 102, userId: 42, subscribedAt: "2026-01-01T00:00:00.000Z" },
      ],
    }, TelegramSubscriptionsSchema);

    const { ChatAgent } = await import("../agents/chat.js");
    (ChatAgent.create as ReturnType<typeof vi.fn>).mockClear();

    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);
    await startTelegramBot(runtime);

    expect((ChatAgent.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("boot drops persisted entries whose user id is no longer allowed", async () => {
    const subsPath = join(tmp, "telegram-subscriptions.json");
    await writeDoc(subsPath, {
      entries: [
        { chatId: 100, userId: 42, subscribedAt: "2026-01-01T00:00:00.000Z" },
        { chatId: 200, userId: 999, subscribedAt: "2026-01-01T00:00:00.000Z" },
      ],
    }, TelegramSubscriptionsSchema);
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    const { ChatAgent } = await import("../agents/chat.js");
    (ChatAgent.create as ReturnType<typeof vi.fn>).mockClear();
    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);
    await startTelegramBot(runtime);

    expect(await readDocOrNull(subsPath, TelegramSubscriptionsSchema)).toEqual({
      entries: [{ chatId: 100, userId: 42, subscribedAt: "2026-01-01T00:00:00.000Z" }],
    });
    expect((ChatAgent.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Dropped 1"));
  });

  it("open mode preserves all persisted entries", async () => {
    const subsPath = join(tmp, "telegram-subscriptions.json");
    const entries = [
      { chatId: 100, userId: 42, subscribedAt: "2026-01-01T00:00:00.000Z" },
      { chatId: 200, userId: 999, subscribedAt: "2026-01-01T00:00:00.000Z" },
    ];
    await writeDoc(subsPath, { entries }, TelegramSubscriptionsSchema);

    const { ChatAgent } = await import("../agents/chat.js");
    (ChatAgent.create as ReturnType<typeof vi.fn>).mockClear();
    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, []);
    await startTelegramBot(runtime);

    expect(await readDocOrNull(subsPath, TelegramSubscriptionsSchema)).toEqual({ entries });
    expect((ChatAgent.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("plain text from allow-listed user does NOT persist the chat", async () => {
    const subsPath = join(tmp, "telegram-subscriptions.json");
    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);
    await startTelegramBot(runtime);

    await dispatch("hello world", 100, 42).promise;

    expect(await readDocOrNull(subsPath, TelegramSubscriptionsSchema)).toBeNull();
  });

  it("boot with corrupt persisted file throws", async () => {
    const subsPath = join(tmp, "telegram-subscriptions.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(subsPath, "not json", "utf-8");

    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);
    await expect(startTelegramBot(runtime)).rejects.toThrow();
  });

  it("helper authorizes identifiable users according to the allowlist", async () => {
    const { isAuthorizedTelegramUser } = await importBot();
    expect(isAuthorizedTelegramUser(42, new Set())).toBe(true);
    expect(isAuthorizedTelegramUser(undefined, new Set())).toBe(false);
    expect(isAuthorizedTelegramUser(42, new Set([42]))).toBe(true);
    expect(isAuthorizedTelegramUser(7, new Set([42]))).toBe(false);
    expect(isAuthorizedTelegramUser(undefined, new Set([42]))).toBe(false);
  });

  it("bot.init rejection short-circuits before bot.start is called", async () => {
    nextInitBehaviour = async () => {
      throw new Error("invalid token");
    };
    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);
    await expect(startTelegramBot(runtime)).rejects.toThrowError(/invalid token/);
    expect(botInstances[0].start).not.toHaveBeenCalled();
  });

  it("bot.start rejection BEFORE onStart propagates to caller", async () => {
    nextStartBehaviour = async () => {
      throw new Error("deleteWebhook failed");
    };
    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);
    await expect(startTelegramBot(runtime)).rejects.toThrowError(/deleteWebhook failed/);
    expect(botInstances[0].init).toHaveBeenCalled();
    expect(botInstances[0].start).toHaveBeenCalled();
  });

  it("bot.start rejection AFTER onStart is logged, not propagated", async () => {
    nextStartBehaviour = async (opts) => {
      opts.onStart?.({ username: "ok", id: 1 });
      throw new Error("Conflict: terminated by other getUpdates");
    };
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);

    await expect(startTelegramBot(runtime)).resolves.toEqual({
      stop: expect.any(Function),
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Conflict: terminated by other getUpdates"));
  });

  it("grammy mock surface mirrors production usage", async () => {
    const { startTelegramBot } = await importBot();
    const runtime = makeRuntimeStub(tmp, [42]);
    await startTelegramBot(runtime);
    expect(botInstances[0]).toEqual(expect.objectContaining({
      init: expect.any(Function),
      start: expect.any(Function),
      stop: expect.any(Function),
      catch: expect.any(Function),
      botInfo: expect.objectContaining({ username: expect.any(String), id: expect.any(Number) }),
      sendMessage: expect.any(Function),
    }));
    expect(botInstances[0].handlers.some((h) => h.event === "message:text")).toBe(true);
  });
});
