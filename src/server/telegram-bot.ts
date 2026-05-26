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
import { readDocOrNull, writeDoc } from "../store/documents.js";
import { TelegramSubscriptionsSchema, type TelegramSubscriptions } from "../types.js";
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

  async function getOrCreateSession(chatId: number): Promise<{
    channel: TelegramChannel;
    sessionId: string;
  }> {
    const existing = sessions.get(chatId);
    if (existing) return existing;

    const sessionId = telegramSessionId(chatId);

    const sendFn = async (text: string, parseMode?: "MarkdownV2") => {
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
      noteManager: runtime.noteManager,
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

    const chatAgent = await ChatAgent.create(
      ctx,
      { channel: "telegram", sessionId },
      channel,
      runtime.eventBus,
      eventFilter,
      runtime.plannerControl,
    );

    runtime.agentRegistry.set(ctx.agentId, chatAgent);

    // Run the chat agent in background
    void (async () => {
      try {
        await chatAgent.run();
      } catch (err) {
        log.error(`[telegram] Chat agent error for chat ${chatId}: ${err}`);
      } finally {
        runtime.agentRegistry.delete(ctx.agentId);
        sessions.delete(chatId);
      }
    })();

    const session = { channel, sessionId };
    sessions.set(chatId, session);
    log.info(`[telegram] New session ${sessionId} for chat ${chatId}`);

    return session;
  }

  // Handle incoming messages
  const subsPath = runtime.project.paths.telegramSubscriptions;

  async function readSubs(): Promise<TelegramSubscriptions> {
    return (await readDocOrNull(subsPath, TelegramSubscriptionsSchema)) ?? { entries: [] };
  }

  async function writeSubs(next: TelegramSubscriptions): Promise<void> {
    await writeDoc(subsPath, next, TelegramSubscriptionsSchema);
  }

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;

    // Access control
    if (!isAuthorizedTelegramUser(userId, allowedUserIds)) {
      log.warn(`[telegram] Rejected message from unauthorized user ${userId}`);
      await ctx.reply("Not authorized.", { link_preview_options: { is_disabled: true } });
      return;
    }

    const text = ctx.message.text.trim();

    if (text === "/subscribe") {
      const subs = await readSubs();
      if (!subs.entries.some((entry) => entry.chatId === chatId)) {
        await writeSubs({
          entries: [
            ...subs.entries,
            { chatId, userId, subscribedAt: new Date().toISOString() },
          ],
        });
        await getOrCreateSession(chatId);
        await bot.api.sendMessage(chatId, "Subscribed to project notifications.");
        log.info(`[telegram] Chat ${chatId} subscribed`);
      } else {
        await bot.api.sendMessage(chatId, "Already subscribed.");
      }
      return;
    }

    if (text === "/unsubscribe") {
      const subs = await readSubs();
      if (subs.entries.some((entry) => entry.chatId === chatId)) {
        await writeSubs({ entries: subs.entries.filter((entry) => entry.chatId !== chatId) });
        const existing = sessions.get(chatId);
        if (existing) {
          existing.channel.close();
          sessions.delete(chatId);
        }
        await bot.api.sendMessage(chatId, "Unsubscribed from project notifications.");
        log.info(`[telegram] Chat ${chatId} unsubscribed`);
      } else {
        await bot.api.sendMessage(chatId, "Not subscribed.");
      }
      return;
    }

    // Reactive session — ephemeral, not persisted.
    const session = await getOrCreateSession(chatId);
    session.channel.pushMessage(ctx.message.text);
  });

  // Error handling
  bot.catch((err) => {
    log.error(`[telegram] Bot error: ${err.message}`);
  });

  if (allowedUserIds.size === 0) {
    log.warn("[telegram] No allowedUserIds configured; accepting identifiable Telegram users");
  }

  // Boot: hydrate persisted subscriptions (notification destinations).
  const persisted = await readSubs();
  const survivors = persisted.entries.filter((entry) => isAuthorizedTelegramUser(entry.userId, allowedUserIds));
  const dropped = persisted.entries.length - survivors.length;
  if (dropped > 0) {
    await writeSubs({ entries: survivors });
    log.warn(`[telegram] Dropped ${dropped} persisted subscription(s) no longer allowed`);
  }
  for (const entry of survivors) await getOrCreateSession(entry.chatId);
  log.info(`[telegram] Restored ${survivors.length} persisted subscription(s)`);

  // Phase 1b: open grammY long polling. Resolve when onStart fires (= init + setup
  // complete, polling loop about to run). Reject only if bot.start rejects BEFORE
  // onStart. Rejections AFTER onStart (first-poll failure, runtime polling failure)
  // are logged, not propagated — see SPEC G47 / 02-design-r3.md §3.1.
  log.info("[telegram] Starting Telegram bot (long polling)...");
  await bot.init();
  log.info(`[telegram] Bot initialized: @${bot.botInfo.username} (${bot.botInfo.id})`);
  await new Promise<void>((resolve, reject) => {
    let started = false;
    bot.start({
      onStart: (botInfo) => {
        started = true;
        log.info(`[telegram] Bot started: @${botInfo.username} (${botInfo.id})`);
        resolve();
      },
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (started) {
        log.error(`[telegram] Polling stopped with error: ${msg}`);
      } else {
        reject(err);
      }
    });
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

export function isAuthorizedTelegramUser(
  userId: number | undefined,
  allowedUserIds: ReadonlySet<number>,
): userId is number {
  if (userId === undefined) return false;
  return allowedUserIds.size === 0 || allowedUserIds.has(userId);
}

function telegramSessionId(chatId: number): string {
  return `telegram-${String(chatId).replace(/^-/, "m")}`;
}
