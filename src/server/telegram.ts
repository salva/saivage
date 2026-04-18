/**
 * Telegram bot — connects Telegram messaging to Saivage chat agents.
 *
 * Authorization: only Telegram user IDs listed in config.telegram.allowedUserIds
 * can interact with the bot. All other messages are silently ignored.
 *
 * One ChatAgent is created per Telegram chat and kept alive across messages.
 * Sessions are reaped after 30 minutes of inactivity.
 */
import { Bot } from "grammy";
import { TelegramChannel } from "../channels/telegram.js";
import { ChatAgent } from "../agents/chat.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { ModelRouter } from "../providers/router.js";
import type { EventBus } from "../orchestrator/eventBus.js";
import type { SaivageConfig } from "../config.js";
import { log } from "../log.js";

interface TelegramSession {
  channel: TelegramChannel;
  chat: ChatAgent;
  lastActivity: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export class TelegramBot {
  private bot: Bot;
  private sessions = new Map<number, TelegramSession>();
  private reapTimer: ReturnType<typeof setInterval> | null = null;
  private allowedUserIds: Set<number>;

  constructor(
    private opts: {
      botToken: string;
      allowedUserIds: number[];
      config: SaivageConfig;
      router: ModelRouter;
      orchestrator: Orchestrator;
      eventBus: EventBus;
    },
  ) {
    this.bot = new Bot(opts.botToken);
    this.allowedUserIds = new Set(opts.allowedUserIds);
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Authorization middleware — reject unauthorized users
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.allowedUserIds.has(userId)) {
        log.warn(
          `Telegram: unauthorized access attempt from user ${userId ?? "unknown"}`,
        );
        return; // silently ignore
      }
      await next();
    });

    // /start command
    this.bot.command("start", async (ctx) => {
      await ctx.reply(
        "Saivage connected. Send me a message to chat with the system.",
      );
    });

    // /status command — quick system status
    this.bot.command("status", async (ctx) => {
      const state = this.opts.orchestrator.getState();
      const active = state.activeAgents.length;
      const pending = state.todos.filter((t) => t.status === "pending").length;
      const inProgress = state.todos.filter(
        (t) => t.status === "in-progress",
      ).length;
      const completed = state.todos.filter(
        (t) => t.status === "completed",
      ).length;

      await ctx.reply(
        `📊 *Saivage Status*\n` +
          `Active agents: ${active}\n` +
          `Tasks: ${pending} pending, ${inProgress} running, ${completed} completed\n` +
          `Total todos: ${state.todos.length}`,
        { parse_mode: "Markdown" },
      );
    });

    // /reset command — clear the conversation
    this.bot.command("reset", async (ctx) => {
      const chatId = ctx.chat.id;
      const session = this.sessions.get(chatId);
      if (session) {
        session.chat.stop();
        session.channel.close();
        this.sessions.delete(chatId);
      }
      await ctx.reply("Conversation reset. Send a new message to start fresh.");
    });

    // Text messages — forward to chat agent
    this.bot.on("message:text", async (ctx) => {
      const chatId = ctx.chat.id;
      const text = ctx.message.text;
      if (!text) return;

      const session = this.getOrCreateSession(chatId, ctx);
      session.lastActivity = Date.now();
      session.channel.pushMessage(text);
    });
  }

  private getOrCreateSession(
    chatId: number,
    ctx: { api: Bot["api"] },
  ): TelegramSession {
    let session = this.sessions.get(chatId);
    if (session) return session;

    const channel = new TelegramChannel(
      chatId,
      async (text: string, parseMode?: "HTML") => {
        try {
          await ctx.api.sendMessage(chatId, text, {
            parse_mode: parseMode,
          });
        } catch (err) {
          // If HTML parsing fails, retry as plain text
          if (parseMode) {
            try {
              await ctx.api.sendMessage(chatId, text);
              return;
            } catch { /* fall through */ }
          }
          log.error(
            `Telegram send error (chat ${chatId}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    );

    const chat = new ChatAgent({
      channel,
      router: this.opts.router,
      orchestrator: this.opts.orchestrator,
      eventBus: this.opts.eventBus,
      config: this.opts.config,
    });

    chat.start();

    session = { channel, chat, lastActivity: Date.now() };
    this.sessions.set(chatId, session);
    log.info(`Telegram: new session for chat ${chatId}`);

    return session;
  }

  /** Start the bot (long polling) */
  async start(): Promise<void> {
    // Reap stale sessions every 5 minutes
    this.reapTimer = setInterval(() => this.reapStaleSessions(), 5 * 60_000);

    this.bot.start({
      onStart: (info) => {
        log.info(`Telegram bot started: @${info.username}`);
      },
    });
  }

  /** Stop the bot gracefully */
  async stop(): Promise<void> {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }

    // Stop all sessions
    for (const [chatId, session] of this.sessions) {
      session.chat.stop();
      session.channel.close();
      this.sessions.delete(chatId);
    }

    await this.bot.stop();
    log.info("Telegram bot stopped");
  }

  private reapStaleSessions(): void {
    const now = Date.now();
    for (const [chatId, session] of this.sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        session.chat.stop();
        session.channel.close();
        this.sessions.delete(chatId);
        log.info(`Telegram: reaped stale session for chat ${chatId}`);
      }
    }
  }
}
