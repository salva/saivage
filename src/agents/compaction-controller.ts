import type { Message, ToolSchema } from "../providers/types.js";
import { log } from "../log.js";
import { buildSurvivorBlock } from "../knowledge/eagerLoader.js";
import type { KnowledgeAgentRole } from "../knowledge/types.js";
import {
  compactConversation,
  isMaxCompactionsReached,
  shouldCompact,
  type CompactionConfig,
  type CompactionState,
} from "../runtime/compaction.js";
import type { AgentRole, InputChannel, LlmClient } from "./types.js";
import type { ConversationEntry } from "./conversation-state.js";

interface CompactionControllerConfig {
  agentId: string;
  role: AgentRole;
  projectRoot: string;
  router: LlmClient;
  modelSpec: string;
  systemPrompt: string;
  compactionConfig: CompactionConfig;
  compactionState: CompactionState;
  inputChannels: InputChannel[];
  getMessages: () => Message[];
  getToolSchemas: () => ToolSchema[];
  replaceMessages: (messages: Message[]) => void;
  addDiagnostic: (kind: ConversationEntry["kind"], content: string) => void;
  onCompactionUpdate?: (
    agentId: string,
    compaction: {
      count: number;
      summarizerFallbacks: number;
      consecutiveFallbacks: number;
      oversizedAtomicFallback: boolean;
    },
  ) => void;
}

export class CompactionController {
  private readonly config: CompactionControllerConfig;

  constructor(config: CompactionControllerConfig) {
    this.config = config;
  }

  shouldCompact(runningTokens: number): boolean {
    return shouldCompact(runningTokens, this.config.compactionConfig);
  }

  isStopReached(): boolean {
    return isMaxCompactionsReached(
      this.config.compactionState,
      this.config.compactionConfig,
    );
  }

  stopReason(): string {
    const { compactionState, compactionConfig } = this.config;
    if (compactionState.oversizedAtomicFallback) {
      return "oversized atomic tool round (use stash)";
    }
    if (compactionState.consecutiveFallbacks >= compactionConfig.maxConsecutiveFallbacks) {
      return "summarizer fallback exhausted";
    }
    return "max compactions exceeded";
  }

  async compact(beforeCompact?: () => Promise<void>): Promise<void> {
    if (beforeCompact) {
      await beforeCompact();
    }

    const {
      agentId,
      role,
      projectRoot,
      router,
      modelSpec,
      systemPrompt,
      compactionConfig,
      compactionState,
    } = this.config;

    const summarized = await compactConversation(
      systemPrompt,
      this.config.getMessages(),
      router,
      {
        ...compactionConfig,
        onFallback: (info) => {
          this.config.addDiagnostic(
            "model_repair",
            `Summarizer fallback (round-parser truncation). keptRounds=${info.keptRounds}${info.oversizedAtomic ? ", oversized atomic round" : ""}.`,
          );
        },
      },
      compactionState,
      modelSpec,
      this.config.getToolSchemas(),
    );

    let next: Message[] = summarized;
    try {
      const block = await buildSurvivorBlock(
        projectRoot,
        role as KnowledgeAgentRole,
        compactionState.compactionCount,
      );
      if (block) next = [...summarized, { role: "user", content: block }];
    } catch (err) {
      log.warn(
        `[agent:${role}:${agentId}] survivor reinjection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.config.replaceMessages(next);
    this.recordCompactionUpdate();
    for (const ch of this.config.inputChannels) ch.onContextReset();
  }

  private recordCompactionUpdate(): void {
    const { agentId, compactionState } = this.config;
    this.config.onCompactionUpdate?.(agentId, {
      count: compactionState.compactionCount,
      summarizerFallbacks: compactionState.summarizerFallbacks,
      consecutiveFallbacks: compactionState.consecutiveFallbacks,
      oversizedAtomicFallback: compactionState.oversizedAtomicFallback,
    });
  }
}
