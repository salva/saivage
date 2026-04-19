/**
 * Saivage — Telegram Bot integration
 *
 * Creates a grammy Bot, wires incoming messages to ChatAgent instances
 * via TelegramChannel, manages per-chat sessions.
 */

import { Bot } from "grammy";
import { TelegramChannel } from "../channels/telegram.js";
import { ChatAgent } from "../agents/chat.js";
import { chatSessionId, agentId } from "../ids.js";
import { log } from "../log.js";
import type { SaivageRuntime } from "./bootstrap.js";

/**
 * Start the Telegram bot and wire it to the Saivage runtime.
 * Returns a stop function to gracefully shut down the bot.
 */
export async function startTelegramBot(
  runtime: SaivageRuntime,
): Promise<{ stop: () => void }> {
  const botToken = runtime.config.telegram.botToken;
  if (!botToken) {
    throw new Error("Telegram bot token not configured (telegram.botToken in config)");
  }

  const allowedUserIds = new Set(runtime.config.telegram.allowedUserIds);

  const bot = new Bot(botToken);

  // Active chat sessions: chatId → { channel, agent }
  const sessions = new Map<
    number,
    { channel: TelegramChannel; sessionId: string }
  >();

  function resolveModelSpec(): string {
    // Chat-specific model override
    const overrides = runtime.project.config.model_overrides;
    if (overrides?.chat) return overrides.chat;
    // Chat model from runtime config (saivage.json) — ideally a cheaper/faster model
    const chatModel = runtime.config.models?.chat;
    if (chatModel) return chatModel;
    return runtime.project.config.provider ?? "openai-codex/gpt-5.3-codex";
  }

  function getOrCreateSession(chatId: number): {
    channel: TelegramChannel;
    sessionId: string;
  } {
    const existing = sessions.get(chatId);
    if (existing) return existing;

    const sessionId = chatSessionId();

    const sendFn = async (text: string, parseMode?: "HTML") => {
      try {
        await bot.api.sendMessage(chatId, text, {
          parse_mode: parseMode,
          disable_web_page_preview: true,
        });
      } catch (err) {
        log.error(`[telegram] Failed to send message to ${chatId}: ${err}`);
      }
    };

    const channel = new TelegramChannel(chatId, sendFn);

    const ctx = {
      project: runtime.project,
      router: runtime.router,
      mcpRuntime: runtime.mcpRuntime,
      agentId: agentId(),
      role: "chat" as const,
      modelSpec: resolveModelSpec(),
    };

    const eventFilter = runtime.config.notifications?.filters
      ? {
          minSeverity: runtime.config.notifications.filters.min_severity,
          categories: runtime.config.notifications.filters.categories,
        }
      : undefined;

    const chatAgent = new ChatAgent(
      ctx,
      { channel: "telegram", sessionId },
      channel,
      runtime.eventBus,
      eventFilter,
    );

    // Run the chat agent in background
    chatAgent.run().catch((err) => {
      log.error(`[telegram] Chat agent error for chat ${chatId}: ${err}`);
      sessions.delete(chatId);
    });

    const session = { channel, sessionId };
    sessions.set(chatId, session);
    log.info(`[telegram] New session ${sessionId} for chat ${chatId}`);

    return session;
  }

  // Handle incoming messages
  bot.on("message:text", (ctx) => {
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;

    // Access control
    if (allowedUserIds.size > 0 && userId && !allowedUserIds.has(userId)) {
      log.warn(`[telegram] Rejected message from unauthorized user ${userId}`);
      return;
    }

    const text = ctx.message.text;
    const session = getOrCreateSession(chatId);

    // Push the message into the channel for the ChatAgent to process
    session.channel.pushMessage(text);
  });

  // Error handling
  bot.catch((err) => {
    log.error(`[telegram] Bot error: ${err.message}`);
  });

  // Start long polling
  log.info("[telegram] Starting Telegram bot (long polling)...");
  bot.start({
    onStart: (botInfo) => {
      log.info(`[telegram] Bot started: @${botInfo.username} (${botInfo.id})`);
    },
  });

  return {
    stop: () => {
      log.info("[telegram] Stopping Telegram bot...");
      bot.stop();
      for (const [, session] of sessions) {
        session.channel.close();
      }
      sessions.clear();
    },
  };
}
