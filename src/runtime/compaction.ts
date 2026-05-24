/**
 * Saivage — Context Compaction
 * Track token usage, trigger at threshold, generate summary, replace history.
 * Max compactions per conversation (default: 3).
 */

import type { Message, ContentBlock, ToolSchema } from "../providers/types.js";
import type { ModelRouter } from "../providers/router.js";
import { log } from "../log.js";

export interface CompactionConfig {
  /** Model context window size in tokens. */
  contextWindow: number;
  /** Threshold percentage (0-100) at which compaction triggers. Default: 80. */
  thresholdPct: number;
  /** Max compactions before forced termination. Default: 3. */
  maxCompactions: number;
  /** Model spec to use for summarization (cheap model). */
  summaryModelSpec: string;
  /** Timeout for the summarization LLM call in ms. Default: 1_200_000 (20 min). */
  summaryTimeoutMs?: number;
}

export interface CompactionState {
  compactionCount: number;
}

const COMPACTION_PROMPT = `Summarize this conversation for continuation. You must include:
1. Your role and current objective
2. Key decisions made so far
3. Outstanding work that remains
4. Important file paths, stage IDs, task IDs, or other references
5. Instructions to re-read authoritative state from disk (plan, tasks, reports)

Be concise but do not lose critical context. This summary will replace the full conversation history.`;

/**
 * Check if compaction should trigger based on the running token count.
 */
export function shouldCompact(
  runningTokens: number,
  config: CompactionConfig,
): boolean {
  const threshold = (config.thresholdPct / 100) * config.contextWindow;
  return runningTokens > threshold;
}

/**
 * Check if the agent has exceeded the max compaction count.
 */
export function isMaxCompactionsReached(
  state: CompactionState,
  config: CompactionConfig,
): boolean {
  return state.compactionCount >= config.maxCompactions;
}

/**
 * Perform context compaction:
 * 1. Summarize the conversation using a cheap LLM call.
 * 2. Replace history with [system_prompt, summary].
 * 3. Increment compaction count.
 *
 * Returns the new message history.
 */
export async function compactConversation(
  systemPrompt: string,
  messages: Message[],
  router: ModelRouter,
  config: CompactionConfig,
  state: CompactionState,
  modelSpec: string,
  tools: ToolSchema[] | undefined,
): Promise<Message[]> {
  log.info(
    `[compaction] Compacting conversation (count: ${state.compactionCount + 1}/${config.maxCompactions}, ` +
    `tokens: ~${router.countTokens(modelSpec, messages, systemPrompt, tools)}, threshold: ${Math.floor((config.thresholdPct / 100) * config.contextWindow)})`,
  );

  // Serialize conversation for summarization
  const serialized = serializeForSummary(messages);
  const timeoutMs = config.summaryTimeoutMs ?? 1_200_000;

  try {
    const chatPromise = router.chat({
      modelSpec: config.summaryModelSpec,
      model: config.summaryModelSpec.split("/")[1] ?? config.summaryModelSpec,
      system: "You are a conversation summarizer. Produce a concise continuation summary.",
      messages: [
        { role: "user", content: `${COMPACTION_PROMPT}\n\n--- CONVERSATION TO SUMMARIZE ---\n${serialized}` },
      ],
      maxTokens: 4000,
    });

    const response = await raceTimeout(chatPromise, timeoutMs);

    const summary = response.content;

    state.compactionCount++;

    // New history: system prompt + summary as a user message
    return [
      {
        role: "user" as const,
        content: `[Context Compaction — Summary of previous conversation]\n\n${summary}\n\n[End of summary. You should re-read authoritative state from disk before continuing.]`,
      },
    ];
  } catch (err) {
    log.error(`[compaction] Summarization failed, falling back to hard truncation: ${err}`);

    // Fallback: keep only the most recent 20% of messages
    const keepCount = Math.max(2, Math.ceil(messages.length * 0.2));
    const recent = messages.slice(-keepCount);

    state.compactionCount++;

    return [
      {
        role: "user" as const,
        content: "[Context was truncated due to length. Re-read state from disk to continue.]",
      },
      ...recent,
    ];
  }
}

/** Serialize messages into a compact text format for summarization. */
function serializeForSummary(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    if (typeof msg.content === "string") {
      parts.push(`[${role}] ${msg.content}`);
    } else if (Array.isArray(msg.content)) {
      const blocks: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          blocks.push(block.text);
        } else if (block.type === "tool_use") {
          blocks.push(`[Tool: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})]`);
        } else if (block.type === "tool_result") {
          const content = block.content ?? "";
          blocks.push(`[Result: ${content.slice(0, 500)}]`);
        }
      }
      parts.push(`[${role}] ${blocks.join(" | ")}`);
    }
  }
  return parts.join("\n");
}

/** Race a promise against a timeout. Rejects with a descriptive error on timeout. */
function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Compaction summarization timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
