/**
 * Telegram chat channel — bridges a Telegram conversation to the ChatAgent.
 *
 * One TelegramChannel per active Telegram user conversation.
 * Messages from the user arrive via grammy, responses are sent back
 * via the Telegram Bot API. Long messages are split at 4096 chars
 * (Telegram's limit).
 *
 * Implements sendEvent() so the ChatAgent's typed events are filtered:
 * only "message" events reach the user; internal events are ignored.
 */
import type { ChatChannel } from "./types.js";
import { log } from "../log.js";

/** Callback to send a message back to the Telegram user */
export type TelegramSendFn = (
  text: string,
  parseMode?: "HTML",
) => Promise<void>;

const TG_MAX_LENGTH = 4096;

// ── Markdown → Telegram HTML conversion ───────────────────────────

/** Escape characters that are special in Telegram HTML */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert common Markdown to Telegram-compatible HTML.
 * Handles: fenced code blocks, inline code, bold, italic, links, headers.
 */
function markdownToTelegramHtml(md: string): string {
  const codeBlocks: string[] = [];
  let html = md.replace(/```(?:\w*)\n([\s\S]*?)```/g, (_m, code: string) => {
    const placeholder = `\x00CODE_BLOCK_${codeBlocks.length}\x00`;
    codeBlocks.push(`<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`);
    return placeholder;
  });

  html = escapeHtml(html);
  const parts = html.split("\x00");

  const processed = parts.map((part) => {
    const codeMatch = /^CODE_BLOCK_(\d+)$/.exec(part);
    if (codeMatch) return codeBlocks[Number(codeMatch[1])] ?? "";

    let text = part;

    // Inline code: `...` → <code>...</code>
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Bold: **...** → <b>...</b>
    text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

    // Italic: *...* → <i>...</i> (but not inside bold tags)
    text = text.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<i>$1</i>");

    // Strikethrough: ~~...~~ → <s>...</s>
    text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

    // Links: [text](url) → <a href="url">text</a>
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Headers: # ... → bold line
    text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

    // Bullet lists: keep as-is (• is Telegram-friendly)
    text = text.replace(/^[-*]\s+/gm, "• ");

    return text;
  });

  return processed.join("");
}

export class TelegramChannel implements ChatChannel {
  private messageHandler:
    | ((message: string) => void | Promise<void>)
    | null = null;
  private closeHandler: (() => void) | null = null;
  private pendingMessages: string[] = [];
  private closed = false;

  constructor(
    readonly chatId: number,
    private sendFn: TelegramSendFn,
  ) {}

  async send(message: string): Promise<void> {
    if (this.closed) return;

    const html = markdownToTelegramHtml(message);

    // Telegram has a 4096-char limit per message
    if (html.length <= TG_MAX_LENGTH) {
      await this.sendFn(html, "HTML");
      return;
    }
    // Split on paragraph boundaries
    let remaining = html;
    while (remaining.length > 0) {
      if (remaining.length <= TG_MAX_LENGTH) {
        await this.sendFn(remaining, "HTML");
        break;
      }
      let splitAt = remaining.lastIndexOf("\n\n", TG_MAX_LENGTH);
      if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", TG_MAX_LENGTH);
      if (splitAt <= 0) splitAt = TG_MAX_LENGTH;
      await this.sendFn(remaining.slice(0, splitAt), "HTML");
      remaining = remaining.slice(splitAt).trimStart();
    }
  }

  /**
   * Handle typed events from ChatAgent. Only forward human-readable
   * "message" events; silently discard internal events (thinking,
   * work_dispatched, agent_progress, etc.).
   */
  sendEvent(event: { type: string; [key: string]: unknown }): void {
    if (event.type === "message" && typeof event.content === "string") {
      this.send(event.content);
    }
    // All other event types are silently ignored for Telegram
  }

  /** Push a user message into the chat agent */
  pushMessage(text: string): void {
    if (!this.messageHandler) {
      this.pendingMessages.push(text);
      return;
    }
    void Promise.resolve(this.messageHandler(text)).catch((err) => {
      log.error(`[telegram] Unhandled message handler error: ${err}`);
    });
  }

  onMessage(handler: (message: string) => void | Promise<void>): void {
    this.messageHandler = handler;
    const pending = this.pendingMessages.splice(0);
    for (const message of pending) {
      void Promise.resolve(this.messageHandler(message)).catch((err) => {
        log.error(`[telegram] Unhandled queued message handler error: ${err}`);
      });
    }
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.();
  }
}
