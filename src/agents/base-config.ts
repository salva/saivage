import type { SkillMatchContext } from "../knowledge/loader.js";
import type { ChildSpawner } from "../runtime/dispatcher.js";
import type { InputChannel } from "./types.js";

/** Configuration for creating a BaseAgent. */
export interface BaseAgentConfig {
  /** System prompt (from prompts/<role>.md). */
  systemPrompt: string;
  /** Skill matching context (kept for documentation; eager block is pre-built by factories). */
  skillContext?: SkillMatchContext;
  /** Pre-built §D.6 eager knowledge block to append to the system prompt. */
  eagerSkillBlock?: string;
  /** Child spawner for agent dispatch tools. */
  childSpawner?: ChildSpawner;
  /** Additional context message injected at the start. */
  initialMessage?: string;
  /** Abort signal shared with the runtime. */
  abortSignal?: { aborted: boolean };
  /** Notify the runtime that this agent is still making progress. */
  onActivity?: (agentId: string) => void;
  /** Notify the runtime when compaction counters change. */
  onCompactionUpdate?: (
    agentId: string,
    compaction: {
      count: number;
      summarizerFallbacks: number;
      consecutiveFallbacks: number;
      oversizedAtomicFallback: boolean;
    },
  ) => void;
  /**
   * Test hook (FR-16 / WI-14): invoked once after the Planner
   * pre-compaction memory-write window closes, with the number of
   * `create_memory` (or related) tool calls observed during the window.
   */
  onCompactionHookComplete?: (writeCount: number) => void;
  /**
   * Input channels that may inject `{role:"user"}` messages immediately
   * before each `router.chat` call, and that observe context resets.
   */
  inputChannels?: InputChannel[];
}
