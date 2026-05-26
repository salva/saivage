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
  /** Max consecutive fallback truncations before forced termination. Default: 3. */
  maxConsecutiveFallbacks: number;
  /** Model spec to use for summarization (cheap model). */
  summaryModelSpec: string;
  /** Timeout for the summarization LLM call in ms. Default: 1_200_000 (20 min). */
  summaryTimeoutMs?: number;
  /** Called when summarization fails and the round-parser fallback is used. */
  onFallback?: (info: {
    error: unknown;
    keptRounds: number;
    oversizedAtomic: boolean;
  }) => void;
}

export interface CompactionState {
  compactionCount: number;
  summarizerFallbacks: number;
  consecutiveFallbacks: number;
  oversizedAtomicFallback: boolean;
}

export type TextRound = { kind: "text"; messages: [Message] };
export type ToolRound = { kind: "tool"; messages: [Message, Message]; toolIds: Set<string> };
export type DanglingHalf = { kind: "dangling"; messages: [Message] };
export type Round = TextRound | ToolRound | DanglingHalf;

export interface SelectOpts {
  config: CompactionConfig;
  router: ModelRouter;
  modelSpec: string;
  systemPrompt: string;
  tools: ToolSchema[] | undefined;
}

const COMPACTION_PROMPT = `Summarize this conversation for continuation. You must include:
1. Your role and current objective
2. Key decisions made so far
3. Outstanding work that remains
4. Important file paths, stage IDs, task IDs, or other references
5. Instructions to re-read authoritative state from disk (plan, tasks, reports)

Be concise but do not lose critical context. This summary will replace the full conversation history.`;

const SAFETY_MARGIN_TOKENS = 1024;

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
  return (
    state.compactionCount >= config.maxCompactions ||
    state.consecutiveFallbacks >= config.maxConsecutiveFallbacks ||
    state.oversizedAtomicFallback === true
  );
}

export function parseRounds(messages: Message[]): Round[] {
  const rounds: Round[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    const toolUseIds = collectToolUseIds(message);
    if (message.role === "assistant" && toolUseIds.size > 0) {
      const next = messages[i + 1];
      const toolResultIds = next ? collectToolResultIds(next) : new Set<string>();
      if (
        next?.role === "user" &&
        toolResultIds.size > 0 &&
        setsEqual(toolUseIds, toolResultIds)
      ) {
        rounds.push({ kind: "tool", messages: [message, next], toolIds: toolUseIds });
        i += 2;
        continue;
      }
      rounds.push({ kind: "dangling", messages: [message] });
      i += 1;
      continue;
    }

    if (message.role === "user" && collectToolResultIds(message).size > 0) {
      rounds.push({ kind: "dangling", messages: [message] });
      i += 1;
      continue;
    }

    rounds.push({ kind: "text", messages: [message] });
    i += 1;
  }
  return rounds;
}

export function selectKeptRounds(
  rounds: Round[],
  opts: SelectOpts,
): { kept: Round[]; oversizedAtomic: boolean } {
  const atomic = rounds.filter((round): round is TextRound | ToolRound => round.kind !== "dangling");
  if (atomic.length === 0) return { kept: [], oversizedAtomic: false };

  const targetTokens =
    Math.floor((opts.config.thresholdPct / 100) * opts.config.contextWindow) -
    SAFETY_MARGIN_TOKENS;
  const kept: Array<TextRound | ToolRound> = [];

  for (let i = atomic.length - 1; i >= 0; i--) {
    const candidate = atomic[i];
    const projected = [candidate, ...kept];
    const projectedTokens = opts.router.countTokens(
      opts.modelSpec,
      flatten(projected),
      opts.systemPrompt,
      opts.tools,
    );
    if (projectedTokens <= targetTokens) {
      kept.unshift(candidate);
      continue;
    }
    if (kept.length === 0) {
      return { kept: [candidate], oversizedAtomic: true };
    }
    break;
  }

  return { kept, oversizedAtomic: false };
}

export function flatten(rounds: Round[]): Message[] {
  return rounds.flatMap((round) => round.messages);
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
    state.consecutiveFallbacks = 0;
    state.oversizedAtomicFallback = false;

    // New history: system prompt + summary as a user message
    return [
      {
        role: "user" as const,
        content: `[Context Compaction — Summary of previous conversation]\n\n${summary}\n\n[End of summary. You should re-read authoritative state from disk before continuing.]`,
      },
    ];
  } catch (err) {
    log.error(`[compaction] Summarization failed, falling back to round-parser truncation: ${err}`);

    state.summarizerFallbacks++;
    state.consecutiveFallbacks++;

    const { kept, oversizedAtomic } = selectKeptRounds(parseRounds(messages), {
      config,
      router,
      modelSpec,
      systemPrompt,
      tools,
    });
    if (oversizedAtomic) {
      state.oversizedAtomicFallback = true;
    }
    config.onFallback?.({ error: err, keptRounds: kept.length, oversizedAtomic });

    return [
      {
        role: "user" as const,
        content: "[Context was truncated due to length. Re-read state from disk to continue.]",
      },
      ...flatten(kept),
    ];
  }
}

function collectToolUseIds(message: Message): Set<string> {
  const ids = new Set<string>();
  if (message.role !== "assistant" || !Array.isArray(message.content)) return ids;
  for (const block of message.content) {
    if (block.type === "tool_use" && block.id) ids.add(block.id);
  }
  return ids;
}

function collectToolResultIds(message: Message): Set<string> {
  const ids = new Set<string>();
  if (message.role !== "user" || !Array.isArray(message.content)) return ids;
  for (const block of message.content) {
    if (block.type === "tool_result" && block.tool_use_id) ids.add(block.tool_use_id);
  }
  return ids;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
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
