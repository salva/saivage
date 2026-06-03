import type { ContentBlock, Message } from "../providers/types.js";

/** A single entry in the serialized conversation snapshot for the dashboard. */
export interface ConversationEntry {
  role: "user" | "assistant" | "system";
  kind:
    | "text"
    | "activity"
    | "model_issue"
    | "model_repair"
    | "model_recovered"
    | "tool_call"
    | "tool_result"
    | "tool_error";
  content: string;
  timestamp: string;
  roundId: string;
  messageIndex: number;
  blockIndex: number;
  toolUseId?: string;
  toolName?: string;
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
}

export interface LlmResponseSource {
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
}

export interface ConversationStateConfig {
  modelSpec: string;
  countTokens: (modelSpec: string, messages: Message[]) => number;
}

const MAX_DIAGNOSTIC_ENTRIES = 30;

export class ConversationState {
  private readonly config: ConversationStateConfig;
  private messageList: Message[] = [];
  private diagnostics: ConversationEntry[] = [];
  private messageTimestamps: string[] = [];
  private messageSources: (LlmResponseSource | undefined)[] = [];
  private messageRoundIds: (string | null)[] = [];
  private roundCounter = 0;
  private compactionCounter = 0;
  private currentRoundId: string | null = null;
  private pendingRoundId: string | null = null;
  private inputTokens = 0;
  private pendingRepairPromptText: string | null = null;

  constructor(config: ConversationStateConfig) {
    this.config = config;
  }

  get messages(): Message[] {
    return this.messageList;
  }

  get messageCount(): number {
    return this.messageList.length;
  }

  get runningInputTokens(): number {
    return this.inputTokens;
  }

  get pendingRepairPrompt(): string | null {
    return this.pendingRepairPromptText;
  }

  setPendingRepairPrompt(prompt: string): void {
    this.pendingRepairPromptText = prompt;
  }

  clearPendingRepairPrompt(): void {
    this.pendingRepairPromptText = null;
  }

  startRound(): string {
    const roundId = `r${++this.roundCounter}`;
    this.pendingRoundId = roundId;
    return roundId;
  }

  clearPendingRound(): void {
    this.pendingRoundId = null;
  }

  restorePendingRound(roundId: string): void {
    this.pendingRoundId = roundId;
  }

  recordReportedInputTokens(reported: number | undefined, staticInputTokens: number): void {
    const estimated = this.inputTokens + staticInputTokens;
    if (typeof reported === "number" && reported > estimated * 1.1) {
      this.inputTokens = Math.max(0, reported - staticInputTokens);
    }
  }

  pushMessage(message: Message, timestamp = new Date().toISOString(), source?: LlmResponseSource): void {
    this.messageList.push(message);
    this.inputTokens += this.config.countTokens(this.config.modelSpec, [message]);
    this.messageTimestamps.push(timestamp);
    this.messageSources.push(source);
    if (message.role === "assistant") {
      const roundId = this.pendingRoundId ?? this.currentRoundId ?? `r-msg:${this.messageList.length - 1}`;
      this.messageRoundIds.push(roundId);
      this.currentRoundId = roundId;
      this.pendingRoundId = null;
    } else {
      this.messageRoundIds.push(null);
    }
  }

  replaceMessages(messages: Message[], timestamp = new Date().toISOString()): void {
    this.messageList = messages;
    this.inputTokens = this.config.countTokens(this.config.modelSpec, messages);
    this.messageTimestamps = messages.map(() => timestamp);
    this.messageSources = messages.map(() => undefined);
    const compactionRound = `r-compacted-${++this.compactionCounter}`;
    this.messageRoundIds = messages.map(() => compactionRound);
    this.currentRoundId = null;
    this.pendingRoundId = null;
  }

  addDiagnostic(
    kind: ConversationEntry["kind"],
    content: string,
    opts?: { roundId?: string; source?: LlmResponseSource },
  ): void {
    const roundId = opts?.roundId ?? this.pendingRoundId ?? this.currentRoundId ?? "r-pre";
    const entry: ConversationEntry = {
      role: "system",
      kind,
      content,
      timestamp: new Date().toISOString(),
      roundId,
      messageIndex: -1,
      blockIndex: this.diagnostics.length,
      ...(opts?.source ?? {}),
    };
    this.diagnostics.push(entry);
    if (this.diagnostics.length > MAX_DIAGNOSTIC_ENTRIES) {
      this.diagnostics.splice(0, this.diagnostics.length - MAX_DIAGNOSTIC_ENTRIES);
    }
  }

  snapshot(): ConversationEntry[] {
    const toolMeta = new Map<string, { name: string; roundId: string }>();
    for (const [idx, msg] of this.messageList.entries()) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      const roundId = this.messageRoundIds[idx] ?? `r-msg:${idx}`;
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id) {
          toolMeta.set(block.id, { name: block.name ?? "unknown", roundId });
        }
      }
    }

    const entries: ConversationEntry[] = [];
    for (const [idx, msg] of this.messageList.entries()) {
      const timestamp = this.messageTimestamps[idx];
      const source = msg.role === "assistant" ? this.messageSources[idx] ?? {} : {};
      const ownRoundId = this.messageRoundIds[idx]
        ?? (msg.role === "assistant" ? `r-msg:${idx}` : `r-msg:${idx}`);

      if (typeof msg.content === "string") {
        entries.push({
          role: msg.role,
          kind: "text",
          content: msg.content,
          timestamp,
          roundId: ownRoundId,
          messageIndex: idx,
          blockIndex: 0,
          ...source,
        });
        continue;
      }
      if (!Array.isArray(msg.content)) continue;

      const textBlocks = msg.content.filter((block) => block.type === "text" && block.text);
      const toolUseBlocks = msg.content.filter((block) => block.type === "tool_use");
      if (msg.role === "assistant" && textBlocks.length === 0 && toolUseBlocks.length > 0) {
        entries.push({
          role: "assistant",
          kind: "activity",
          content: describeToolUseBlocks(toolUseBlocks),
          timestamp,
          roundId: ownRoundId,
          messageIndex: idx,
          blockIndex: -1,
          ...source,
        });
      }

      for (const [bIdx, block] of msg.content.entries()) {
        if (block.type === "text" && block.text) {
          entries.push({
            role: msg.role,
            kind: "text",
            content: block.text,
            timestamp,
            roundId: ownRoundId,
            messageIndex: idx,
            blockIndex: bIdx,
            ...source,
          });
        } else if (block.type === "tool_use") {
          const inputStr = typeof block.input === "string"
            ? block.input
            : JSON.stringify(block.input, null, 2);
          entries.push({
            role: "assistant",
            kind: "tool_call",
            toolUseId: block.id,
            toolName: block.name ?? "unknown",
            content: inputStr.length > 2000 ? `${inputStr.slice(0, 2000)}\n…(truncated)` : inputStr,
            timestamp,
            roundId: ownRoundId,
            messageIndex: idx,
            blockIndex: bIdx,
            ...source,
          });
        } else if (block.type === "tool_result") {
          const meta = block.tool_use_id ? toolMeta.get(block.tool_use_id) : undefined;
          const text = block.content ?? block.text ?? "";
          entries.push({
            role: "system",
            kind: block.is_error ? "tool_error" : "tool_result",
            toolUseId: block.tool_use_id,
            toolName: meta?.name,
            content: text.length > 3000 ? `${text.slice(0, 3000)}\n…(truncated)` : text,
            timestamp,
            roundId: meta?.roundId ?? ownRoundId,
            messageIndex: idx,
            blockIndex: bIdx,
          });
        }
      }
    }

    return [...entries, ...this.diagnostics].sort(
      (a, b) =>
        a.timestamp.localeCompare(b.timestamp)
        || a.messageIndex - b.messageIndex
        || a.blockIndex - b.blockIndex,
    );
  }
}

function describeToolUseBlocks(blocks: ContentBlock[]): string {
  const names = blocks.map((block) => block.name ?? "unknown");
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const summary = Array.from(counts.entries())
    .map(([name, count]) => count === 1 ? name : `${name} x${count}`)
    .join(", ");
  const noun = blocks.length === 1 ? "tool" : "tools";
  return `Using ${blocks.length} ${noun}: ${summary}`;
}
