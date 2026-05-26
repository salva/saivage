/**
 * Telegram chat channel — bridges a Telegram conversation to the ChatAgent.
 *
 * Conversion to Telegram MarkdownV2 is delegated to `telegramify-markdown`.
 * Long outgoing messages are split on the SOURCE markdown side using a
 * block- and span-aware splitter, then each fragment is independently
 * converted to MarkdownV2. This avoids the dangling-escape and mid-fence
 * problems of slicing already-escaped text at 4096 bytes.
 */
import telegramifyMarkdown from "telegramify-markdown";
import type { ChatChannel } from "./types.js";
import type { WsOutbound } from "./ws-schema.js";
import { log } from "../log.js";

/** Callback to send a message back to the Telegram user. */
export type TelegramSendFn = (
  text: string,
  parseMode?: "MarkdownV2",
) => Promise<void>;

const TG_MAX_LENGTH = 4096;

// ─── Source-side splitter ────────────────────────────────────────────────

function convertedLen(md: string): number {
  return telegramifyMarkdown(md, "escape").length;
}

/**
 * Tokenize a markdown string into block units. Each fenced code block
 * (```...```) is one atomic unit; everything else is grouped by
 * blank-line separators into paragraph units.
 */
function tokenizeBlocks(md: string): string[] {
  const lines = md.split("\n");
  const blocks: string[] = [];
  const fenceOpen = /^ {0,3}```([^\n]*)$/;
  const fenceClose = /^ {0,3}```\s*$/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (fenceOpen.test(line)) {
      // Consume up to and including the matching closer (or EOF).
      const start = i;
      i++;
      while (i < lines.length && !fenceClose.test(lines[i])) i++;
      if (i < lines.length) i++; // include closer
      blocks.push(lines.slice(start, i).join("\n"));
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const start = i;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !fenceOpen.test(lines[i])
    ) {
      i++;
    }
    blocks.push(lines.slice(start, i).join("\n"));
  }
  return blocks;
}

/**
 * Tokenize a paragraph into atomic spans: fenced inline code, link,
 * emphasis, plain text. The order is greedy at each cursor position.
 */
type Span =
  | { kind: "code"; text: string }
  | { kind: "link"; text: string }
  | { kind: "emphasis"; text: string }
  | { kind: "text"; text: string };

function tokenizeSpans(paragraph: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  const n = paragraph.length;
  // Patterns anchored at the cursor.
  const codeRe = /^`([^`]+)`/;
  const linkRe = /^\[([^\]]+)\]\(([^)]+)\)/;
  const boldStarRe = /^\*\*([\s\S]+?)\*\*/;
  const boldUnderRe = /^__([\s\S]+?)__/;
  const italStarRe = /^\*([^*\s][\s\S]*?)\*/;
  const italUnderRe = /^_([^_\s][\s\S]*?)_/;

  while (i < n) {
    const rest = paragraph.slice(i);
    let m: RegExpExecArray | null;
    if ((m = codeRe.exec(rest))) {
      spans.push({ kind: "code", text: m[0] });
      i += m[0].length;
      continue;
    }
    if ((m = linkRe.exec(rest))) {
      spans.push({ kind: "link", text: m[0] });
      i += m[0].length;
      continue;
    }
    if ((m = boldStarRe.exec(rest))) {
      spans.push({ kind: "emphasis", text: m[0] });
      i += m[0].length;
      continue;
    }
    if ((m = boldUnderRe.exec(rest))) {
      spans.push({ kind: "emphasis", text: m[0] });
      i += m[0].length;
      continue;
    }
    if ((m = italStarRe.exec(rest))) {
      spans.push({ kind: "emphasis", text: m[0] });
      i += m[0].length;
      continue;
    }
    if ((m = italUnderRe.exec(rest))) {
      spans.push({ kind: "emphasis", text: m[0] });
      i += m[0].length;
      continue;
    }
    // Plain-text run up to the next span-start character.
    let j = i + 1;
    while (j < n) {
      const c = paragraph[j];
      if (c === "`" || c === "[" || c === "*" || c === "_") break;
      j++;
    }
    spans.push({ kind: "text", text: paragraph.slice(i, j) });
    i = j;
  }
  return spans;
}

/** Hard-cut a string at a code-point boundary so its converted length <= max. */
function hardCutToMax(s: string, max: number): { head: string; tail: string } {
  // Binary search by code points.
  const cps = Array.from(s);
  let lo = 1;
  let hi = cps.length;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = cps.slice(0, mid).join("");
    if (convertedLen(candidate) <= max) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return {
    head: cps.slice(0, best).join(""),
    tail: cps.slice(best).join(""),
  };
}

function splitParagraphIntoAtomicSpans(paragraph: string, max: number): string[] {
  const spans = tokenizeSpans(paragraph);
  const out: string[] = [];
  let current = "";

  const flush = () => {
    if (current !== "") {
      out.push(current);
      current = "";
    }
  };

  const tryAdd = (chunk: string): boolean => {
    const candidate = current === "" ? chunk : current + chunk;
    if (convertedLen(candidate) <= max) {
      current = candidate;
      return true;
    }
    return false;
  };

  for (const span of spans) {
    if (tryAdd(span.text)) continue;
    // Doesn't fit alongside current; flush and try alone.
    flush();
    if (tryAdd(span.text)) continue;
    // Single span doesn't fit on its own. Plain-text runs can be re-split
    // at whitespace; formatted spans get hard-cut on their raw source.
    if (span.kind === "text") {
      const words = span.text.split(/(\s+)/);
      for (const w of words) {
        if (tryAdd(w)) continue;
        flush();
        if (tryAdd(w)) continue;
        // A single word over the limit: hard-cut it on raw source.
        let remaining = w;
        while (remaining.length > 0) {
          const { head, tail } = hardCutToMax(remaining, max);
          if (head === "") break; // safety
          if (tryAdd(head)) {
            flush();
          } else {
            out.push(head);
          }
          remaining = tail;
        }
      }
    } else {
      // Formatted span too big — hard-cut on raw source. Degrades formatting
      // at the cut by design (documented in F17 design r3).
      let remaining = span.text;
      while (remaining.length > 0) {
        const { head, tail } = hardCutToMax(remaining, max);
        if (head === "") break;
        if (tryAdd(head)) {
          flush();
        } else {
          out.push(head);
        }
        remaining = tail;
      }
    }
  }
  flush();
  return out;
}

function splitOversizedBlock(block: string, max: number): string[] {
  const lines = block.split("\n");
  const fenceOpen = /^ {0,3}```([^\n]*)$/;
  const fenceClose = /^ {0,3}```\s*$/;

  // Fenced code block: split contents by line; wrap each chunk with the
  // original opener (including language tag) and closer.
  if (lines.length >= 2 && fenceOpen.test(lines[0]) && fenceClose.test(lines[lines.length - 1])) {
    const opener = lines[0];
    const closer = lines[lines.length - 1];
    const body = lines.slice(1, -1);

    const out: string[] = [];
    let current: string[] = [];
    const flush = () => {
      if (current.length === 0) return;
      out.push([opener, ...current, closer].join("\n"));
      current = [];
    };

    for (const line of body) {
      const candidateBody = [...current, line];
      const candidate = [opener, ...candidateBody, closer].join("\n");
      if (convertedLen(candidate) <= max) {
        current = candidateBody;
        continue;
      }
      if (current.length === 0) {
        // A single body line plus fence wrappers already exceeds the limit.
        // Emit a fenced wrapper around a hard-cut of the line.
        let remaining = line;
        while (remaining.length > 0) {
          // Find largest prefix that fits inside a single fenced block.
          let lo = 1, hi = Array.from(remaining).length, best = 1;
          const cps = Array.from(remaining);
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const candidate = [opener, cps.slice(0, mid).join(""), closer].join("\n");
            if (convertedLen(candidate) <= max) {
              best = mid;
              lo = mid + 1;
            } else {
              hi = mid - 1;
            }
          }
          out.push([opener, cps.slice(0, best).join(""), closer].join("\n"));
          remaining = cps.slice(best).join("");
        }
        continue;
      }
      flush();
      current = [line];
    }
    flush();
    return out;
  }

  // Paragraph: split by '\n' lines first, then by sentence, then span-aware.
  const out: string[] = [];
  let current = "";
  const flush = () => {
    if (current !== "") {
      out.push(current);
      current = "";
    }
  };
  const tryAdd = (chunk: string, joiner: string): boolean => {
    const candidate = current === "" ? chunk : current + joiner + chunk;
    if (convertedLen(candidate) <= max) {
      current = candidate;
      return true;
    }
    return false;
  };

  for (const line of lines) {
    if (tryAdd(line, "\n")) continue;
    flush();
    if (tryAdd(line, "\n")) continue;
    // Line still too big: split by sentence boundary.
    const sentences = line.split(/(?<=[.?!])\s+/);
    for (const sentence of sentences) {
      if (tryAdd(sentence, " ")) continue;
      flush();
      if (tryAdd(sentence, " ")) continue;
      // Sentence still too big: hand to span-aware splitter.
      for (const piece of splitParagraphIntoAtomicSpans(sentence, max)) {
        if (tryAdd(piece, "")) continue;
        flush();
        if (tryAdd(piece, "")) continue;
        // Should not happen; emit alone as last resort.
        out.push(piece);
      }
    }
  }
  flush();
  return out;
}

function splitSourceForTelegram(md: string, max: number): string[] {
  const blocks = tokenizeBlocks(md);
  const out: string[] = [];
  let current = "";
  for (const block of blocks) {
    const candidate = current === "" ? block : current + "\n\n" + block;
    if (convertedLen(candidate) <= max) {
      current = candidate;
      continue;
    }
    if (current !== "") {
      out.push(current);
      current = "";
    }
    if (convertedLen(block) <= max) {
      current = block;
    } else {
      for (const piece of splitOversizedBlock(block, max)) out.push(piece);
    }
  }
  if (current !== "") out.push(current);
  return out;
}

// ─── Channel ─────────────────────────────────────────────────────────────

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
    for (const fragment of splitSourceForTelegram(message, TG_MAX_LENGTH)) {
      await this.sendFn(telegramifyMarkdown(fragment, "escape"), "MarkdownV2");
    }
  }

  /**
   * Handle typed events from ChatAgent. Only forward human-readable
   * "message" events; silently discard internal events.
   */
  sendEvent(event: WsOutbound): void {
    switch (event.type) {
      case "message":
        void this.send(event.content);
        return;
      case "session":
      case "thinking":
      case "system":
      case "event":
        return;
    }
  }

  /** Push a user message into the chat agent. */
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
