/**
 * F07 — Accurate token counting via js-tiktoken.
 *
 * Replaces the legacy `chars/4` estimator with a per-block BPE count that
 * handles `thinking`, `tool_use`, `tool_result`, and `image` blocks
 * explicitly.
 */
import { Tiktoken, getEncoding } from "js-tiktoken";
import type { Message, ContentBlock, ToolSchema } from "../providers/types.js";
import { log } from "../log.js";

export type TiktokenEncodingName = "cl100k_base" | "o200k_base";

const IMAGE_TOKENS = 1568;
const TOOL_USE_ENVELOPE = 3;

let cl100k: Tiktoken | null = null;
let o200k: Tiktoken | null = null;
const warnedUnknownBlockTypes = new Set<string>();

function getEncoder(encoding: TiktokenEncodingName): Tiktoken {
  if (encoding === "cl100k_base") {
    cl100k ??= getEncoding("cl100k_base");
    return cl100k;
  }
  o200k ??= getEncoding("o200k_base");
  return o200k;
}

function countText(encoder: Tiktoken, text: string): number {
  if (!text) return 0;
  return encoder.encode(text).length;
}

export function countTextWithTiktoken(text: string, encoding: TiktokenEncodingName): number {
  return countText(getEncoder(encoding), text);
}

function countBlock(encoder: Tiktoken, block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return countText(encoder, block.text ?? "");
    case "thinking":
      return countText(encoder, block.thinking ?? block.text ?? "");
    case "tool_result":
      return countText(encoder, block.content ?? "");
    case "tool_use": {
      const payload = block.input === undefined ? "" : JSON.stringify(block.input);
      return countText(encoder, payload) + TOOL_USE_ENVELOPE;
    }
    case "image":
      return IMAGE_TOKENS;
    default: {
      const t = String((block as { type?: unknown }).type ?? "unknown");
      if (!warnedUnknownBlockTypes.has(t)) {
        warnedUnknownBlockTypes.add(t);
        log.warn(`[token-counting] Unknown content block type "${t}" — counted as 0 tokens`);
      }
      return 0;
    }
  }
}

export function countWithTiktoken(
  messages: Message[],
  system: string | undefined,
  tools: ToolSchema[] | undefined,
  encoding: TiktokenEncodingName,
): number {
  const encoder = getEncoder(encoding);
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += countText(encoder, msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        total += countBlock(encoder, block);
      }
    }
  }
  if (system) total += countText(encoder, system);
  if (tools && tools.length > 0) total += countText(encoder, JSON.stringify(tools));
  return total;
}
