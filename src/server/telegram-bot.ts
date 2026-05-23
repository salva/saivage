/**
 * Saivage — Telegram Bot integration
 *
 * Creates a grammy Bot, wires incoming messages to ChatAgent instances
 * via TelegramChannel, manages per-chat sessions.
 */

import { Bot } from "grammy";
import { TelegramChannel } from "../channels/telegram.js";
import { ChatAgent } from "../agents/chat.js";
import { agentId } from "../ids.js";
import { log } from "../log.js";
import type { SaivageRuntime } from "./bootstrap.js";

/**
 * Start the Telegram bot and wire it to the Saivage runtime.
 * Returns a stop function to gracefully shut down the bot.
 */
export async function startTelegramBot(
  runtime: SaivageRuntime,
): Promise<{ stop: () => Promise<void> }> {
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

  function resolveChatRoute() {
    const route = runtime.routing.resolve("chat");
    return {
      modelSpec: route.modelSpec,
      authProfileKey: route.authProfile,
      accountRef: route.accountRef,
    };
  }

  function getOrCreateSession(chatId: number): {
    channel: TelegramChannel;
    sessionId: string;
  } {
    const existing = sessions.get(chatId);
    if (existing) return existing;

    const sessionId = telegramSessionId(chatId);

    const sendFn = async (text: string, parseMode?: "HTML") => {
      try {
        await bot.api.sendMessage(chatId, text, {
          parse_mode: parseMode,
          link_preview_options: { is_disabled: true },
        });
      } catch (err) {
        log.error(`[telegram] Failed to send message to ${chatId}: ${err}`);
        throw err;
      }
    };

    const channel = new TelegramChannel(chatId, sendFn);

    const ctx = {
      project: runtime.project,
      router: runtime.router,
      mcpRuntime: runtime.mcpRuntime,
      agentId: agentId(),
      role: "chat" as const,
      channelId: "telegram",
      sessionId,
      ...resolveChatRoute(),
    };

    const eventFilter = runtime.config.notifications?.filters
      ? {
          minSeverity: runtime.config.notifications.filters.min_severity,
          allowedTypes: runtime.config.notifications.filters.categories.length
            ? runtime.config.notifications.filters.categories
            : undefined,
        }
      : undefined;

    const chatAgent = new ChatAgent(
      ctx,
      { channel: "telegram", sessionId },
      channel,
      runtime.eventBus,
      eventFilter,
      runtime.plannerControl,
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
    if (allowedUserIds.size > 0 && (!userId || !allowedUserIds.has(userId))) {
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

  if (allowedUserIds.size > 0) {
    for (const userId of allowedUserIds) getOrCreateSession(userId);
    log.info(`[telegram] Pre-subscribed ${allowedUserIds.size} allowed user(s) for project notifications`);
  } else {
    log.warn("[telegram] No allowedUserIds configured; project notifications begin only after a chat sends a message");
  }

  // Start long polling
  log.info("[telegram] Starting Telegram bot (long polling)...");
  bot.start({
    onStart: (botInfo) => {
      log.info(`[telegram] Bot started: @${botInfo.username} (${botInfo.id})`);
    },
  });

  return {
    stop: async () => {
      log.info("[telegram] Stopping Telegram bot...");
      await bot.stop();
      for (const [, session] of sessions) {
        session.channel.close();
      }
      sessions.clear();
    },
  };
}

function telegramSessionId(chatId: number): string {
  return `telegram-${String(chatId).replace(/^-/, "m")}`;
}
