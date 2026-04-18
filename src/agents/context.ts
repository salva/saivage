/**
 * Context window management — compaction at 80% capacity.
 * Summarizes older messages to free context space.
 */
import type { Message } from "../providers/types.js";
import type { ModelRouter } from "../providers/router.js";
import { parseModelId } from "../providers/types.js";
import { log } from "../log.js";

/** Rough token estimate: ~4 chars per token */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Total token estimate for a message array */
export function estimateConversationTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return sum + estimateTokens(content);
  }, 0);
}

/**
 * Compact a conversation when context usage exceeds threshold.
 * Keeps the latest N messages and summarizes older ones.
 */
export async function compactIfNeeded(
  messages: Message[],
  router: ModelRouter,
  opts?: {
    maxTokens?: number;
    thresholdPercent?: number;
    keepRecent?: number;
  },
): Promise<Message[]> {
  const maxTokens = opts?.maxTokens ?? 100_000;
  const threshold = opts?.thresholdPercent ?? 0.8;
  const keepRecent = opts?.keepRecent ?? 6;

  const currentTokens = estimateConversationTokens(messages);
  const limit = maxTokens * threshold;

  if (currentTokens <= limit || messages.length <= keepRecent) {
    return messages;
  }

  log.info(
    `Context compaction: ${currentTokens} tokens > ${limit} limit. Compacting ${messages.length - keepRecent} older messages.`,
  );

  // Split: old messages to summarize, recent to keep
  const toSummarize = messages.slice(0, messages.length - keepRecent);
  const toKeep = messages.slice(messages.length - keepRecent);

  const summary = await summarizeMessages(toSummarize, router);

  return [
    {
      role: "system" as const,
      content: `[Context Summary]\nThe following is a summary of the earlier conversation:\n${summary}`,
    },
    ...toKeep,
  ];
}

async function summarizeMessages(
  messages: Message[],
  router: ModelRouter,
): Promise<string> {
  const conversation = messages
    .map((m) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${m.role}: ${content}`;
    })
    .join("\n");

  const modelSpec = router.resolveModelForRole("chat");
  const { model } = parseModelId(modelSpec);

  const response = await router.chat({
    modelSpec,
    model,
    system: "Summarize the following conversation concisely, preserving key decisions, results, and context needed for continued work. Be brief.",
    messages: [{ role: "user", content: conversation }],
    maxTokens: 1024,
  });

  return response.content;
}
