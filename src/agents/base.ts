import { randomUUID } from "node:crypto";
import type { EventBus } from "../orchestrator/eventBus.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { ModelRouter } from "../providers/router.js";
import type {
  TaskAssignment,
  AgentProgressEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentBlockedEvent,
} from "./protocol.js";
import type {
  Message,
  ToolSchema,
  ChatResponse,
  ToolCallResult,
  ContentBlock,
} from "../providers/types.js";
import type { SaivageConfig } from "../config.js";
import type { Skill } from "../skills/types.js";
import { resolveSkills, formatSkillsForPrompt } from "../skills/resolver.js";
import { log } from "../log.js";
import { stashResult, readStash, cleanStash } from "./stash.js";

export interface ConversationLogEntry {
  role: string;
  type: "text" | "thinking" | "tool_call" | "tool_result";
  text?: string;
  tool?: string;
  args?: string;
  isError?: boolean;
}

export interface SubAgentConfig {
  type: string;
  systemPrompt: string;
  modelRole: string; // Key into config.models
  tools?: string[]; // Allowed services (if empty = all)
  rogueCheckInterval?: number; // Run LLM judge every N iterations (default: 25)
}

export interface SubAgentDeps {
  router: ModelRouter;
  runtime: McpRuntime;
  eventBus: EventBus;
  config: SaivageConfig;
  allSkills: Skill[];
}

/**
 * Base sub-agent with ReAct loop.
 * Subclasses override `systemPrompt` and `config` to specialise.
 */
export class SubAgent {
  readonly id: string;
  protected config: SubAgentConfig;
  protected deps: SubAgentDeps;
  protected messages: Message[] = [];
  private cancelled = false;
  private task: TaskAssignment | null = null;
  private systemPromptWithSkills: string = "";
  /** Track tool call names per iteration for rogue detection */
  private iterationToolCalls: string[][] = [];

  constructor(config: SubAgentConfig, deps: SubAgentDeps) {
    this.id = randomUUID();
    this.config = config;
    this.deps = deps;
  }

  /** Run the ReAct loop for a given task */
  async run(task: TaskAssignment): Promise<string> {
    this.task = task;
    this.cancelled = false;
    this.iterationToolCalls = [];
    const rogueCheckInterval = this.config.rogueCheckInterval ?? 25;

    // Build tool schemas from MCP runtime
    const tools = this.getToolSchemas();

    // Resolve skills for this task and build the system prompt
    const resolvedSkills = resolveSkills({
      allSkills: this.deps.allSkills,
      explicit: task.skills,
      agentType: this.config.type,
      goalText: task.goal,
    });
    const skillBlock = formatSkillsForPrompt(resolvedSkills);
    this.systemPromptWithSkills = skillBlock
      ? `${this.config.systemPrompt}\n\n${skillBlock}`
      : this.config.systemPrompt;

    if (resolvedSkills.length > 0) {
      log.info(`Agent ${this.id.slice(0, 8)}: loaded ${resolvedSkills.length} skills: ${resolvedSkills.map(s => s.metadata.name).join(", ")}`);
    }

    // Initial user message
    this.messages = [
      { role: "user", content: this.buildInitialPrompt(task) },
    ];

    let lastToolSummary = "";

    for (let i = 0; ; i++) {
      if (this.cancelled) {
        await this.emitFailed("Cancelled by user", i);
        throw new Error("Agent cancelled");
      }

      // Inject any out-of-band messages (e.g. from message_agent tool)
      while (this.pendingInjections.length > 0) {
        const injected = this.pendingInjections.shift()!;
        this.messages.push({
          role: "user",
          content: `[SYSTEM MESSAGE FROM ORCHESTRATOR]: ${injected}`,
        });
        log.info(`Agent ${this.id.slice(0, 8)} iter ${i}: injected OOB message`);
      }

      await this.emitProgress(i, lastToolSummary || `Iteration ${i + 1}`);

      // Call LLM with exponential backoff retry
      const modelSpec = this.deps.router.resolveModelForRole(
        this.config.modelRole,
      );
      log.info(`Agent ${this.id.slice(0, 8)} iter ${i}: calling ${modelSpec}`);
      let response: ChatResponse;
      const baseDelaySec = 30;
      const backoffMult = 1.5;
      const maxDelaySec = 20 * 60; // 20 minutes
      for (let attempt = 0; ; attempt++) {
        if (this.cancelled) {
          await this.emitFailed("Cancelled by user", i);
          throw new Error("Agent cancelled");
        }
        try {
          response = await this.deps.router.chat({
            modelSpec,
            model: modelSpec.split("/").slice(1).join("/"),
            system: this.systemPromptWithSkills,
            messages: this.messages,
            tools: tools.length > 0 ? tools : undefined,
            maxTokens: 8192,
          });
          log.info(`Agent ${this.id.slice(0, 8)} iter ${i}: LLM responded (${response.usage.inputTokens}in/${response.usage.outputTokens}out, ${response.toolCalls.length} tool calls)`);

          // Proactive compaction: summarize before hitting the wall.
          // Trigger when input tokens exceed 80% of a ~128k context window.
          const compactThreshold = 100_000;
          if (response.usage.inputTokens > compactThreshold && this.messages.length > 5) {
            const before = this.messages.length;
            await this.compactConversation(`proactive: ${response.usage.inputTokens} input tokens`);
            log.info(`Agent ${this.id.slice(0, 8)} iter ${i}: proactive compaction ${before}→${this.messages.length} messages`);
            await this.emitProgress(i, `📝 Conversation summarized (${before}→${this.messages.length} msgs, ${response.usage.inputTokens} tokens)`);
          }

          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);

          // Non-retryable errors — compact conversation and retry immediately
          const isContextOverflow = msg.includes("exceeds the context window") || msg.includes("context_length_exceeded");
          const isOrphanedToolResult = msg.includes("No tool call found for function call output") || msg.includes("tool_use_id");
          if (isContextOverflow || isOrphanedToolResult) {
            const reason = isContextOverflow ? "context window exceeded" : "orphaned tool_result after compaction";
            const before = this.messages.length;
            await this.compactConversation(reason);
            log.warn(`Agent ${this.id.slice(0, 8)} iter ${i}: ${reason} — compacted ${before}→${this.messages.length} messages`);
            await this.emitProgress(i, `✂️ ${reason}, compacted (${before}→${this.messages.length} msgs)`);
            continue; // retry immediately with shorter conversation
          }

          const delaySec = Math.min(baseDelaySec * Math.pow(backoffMult, attempt), maxDelaySec);
          log.warn(`Agent ${this.id.slice(0, 8)} iter ${i}: LLM failed (attempt ${attempt + 1}): ${msg} — retrying in ${Math.round(delaySec)}s`);
          await this.emitProgress(i, `⏳ LLM throttled, waiting ${delaySec}s before retry (attempt ${attempt + 1})`);
          await new Promise((r) => setTimeout(r, delaySec * 1000));
          // Clear sticky failovers so we try the primary model again
          this.deps.router.clearStickyFailover(modelSpec);
        }
      }

      // Process response
      if (response.toolCalls.length === 0) {
        // Agent is done — final response
        this.messages.push({
          role: "assistant",
          content: response.content,
        });
        await this.emitCompleted(response.content);
        return response.content;
      }

      // Track tool calls for this iteration (name + stable hash of args)
      const toolSigs = response.toolCalls.map((tc) => {
        const argStr = JSON.stringify(tc.input ?? {});
        return `${tc.name}(${argStr})`;
      });
      this.iterationToolCalls.push(toolSigs);
      const toolNames = response.toolCalls.map((tc) => tc.name).join(", ");
      const thinking = response.content?.slice(0, 120) || "";
      lastToolSummary = thinking
        ? `${thinking}${thinking.length >= 120 ? "…" : ""} → ${toolNames}`
        : toolNames;

      // Cheap pattern-based spin check (catches blatant infinite loops)
      if (this.isSpinning()) {
        const msg = `Agent appears stuck — repeated identical tool calls for ${this.iterationToolCalls.length} iterations`;
        log.warn(msg);
        await this.emitFailed(msg, i);
        throw new Error(msg);
      }

      // Periodic LLM rogue judge — runs every rogueCheckInterval iterations
      if (i > 0 && i % rogueCheckInterval === 0) {
        const verdict = await this.judgeProgress(task, i);
        if (verdict.rogue) {
          const msg = `Rogue judge terminated agent at iteration ${i}: ${verdict.reason}`;
          log.warn(msg);
          // Ask the agent for a partial summary before killing it
          const partial = verdict.partialResult
            || `Agent terminated by rogue judge at iteration ${i}. Reason: ${verdict.reason}. Last tools: ${lastToolSummary}.`;
          await this.emitCompleted(partial);
          return partial;
        }
        log.info(`Rogue judge (iter ${i}): continuing — ${verdict.reason}`);
      }

      // Build assistant message with tool calls
      const assistantBlocks: ContentBlock[] = [];
      if (response.content) {
        assistantBlocks.push({ type: "text", text: response.content });
      }
      for (const tc of response.toolCalls) {
        assistantBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }
      this.messages.push({ role: "assistant", content: assistantBlocks });

      // Execute tool calls, stashing oversized results
      const modelSpec_ = this.deps.router.resolveModelForRole(this.config.modelRole);
      const ctxTokens = this.deps.router.getMaxContextTokens(modelSpec_);
      const stashThresholdChars = Math.floor(ctxTokens * 4 * 0.05); // 5% of context window in chars

      const resultBlocks: ContentBlock[] = [];
      for (const tc of response.toolCalls) {
        const result = await this.executeTool(tc);
        let content = typeof result === "string" ? result : JSON.stringify(result);

        if (content.length > stashThresholdChars) {
          const stashPath = stashResult(content, tc.name);
          const preview = content.slice(0, 500);
          content = `[Result too large: ${content.length} chars, stashed to file]\n`
            + `Path: ${stashPath}\n`
            + `Total size: ${content.length} chars\n`
            + `Use read_stash(path="${stashPath}", offset=0, length=10000) to read portions.\n`
            + `\n--- Preview (first 500 chars) ---\n${preview}`;
          log.info(`Agent ${this.id.slice(0, 8)}: stashed ${tc.name} result (${(content.length / 1000).toFixed(0)}k chars) → ${stashPath}`);
        }

        resultBlocks.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content,
          is_error: false,
        });
      }
      this.messages.push({ role: "user", content: resultBlocks });
    }

  }

  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Inject an out-of-band user message into the agent's conversation.
   * The message will be picked up at the start of the next iteration,
   * allowing runtime redirection without killing the agent.
   */
  private pendingInjections: string[] = [];

  injectMessage(text: string): void {
    this.pendingInjections.push(text);
  }

  /**
   * Summarize the oldest ~80% of conversation messages using a cheap LLM call,
   * keeping the initial task prompt and the most recent ~20% verbatim.
   * Mimics Copilot's approach: older context → LLM summary, recent context → preserved.
   * Falls back to hard truncation if the summarization call fails.
   */
  async compactConversation(reason: string): Promise<void> {
    // If we're already at minimal messages, truncate large content blocks
    if (this.messages.length <= 5) {
      this.truncateLargeBlocks();
      return;
    }

    const first = this.messages[0]; // Original task prompt
    const middle = this.messages.slice(1); // Everything after the task prompt

    // Keep the most recent ~20% verbatim (minimum 4 messages)
    const keepRecent = Math.max(4, Math.floor(middle.length * 0.2));
    const toSummarize = middle.slice(0, middle.length - keepRecent);
    const recent = middle.slice(middle.length - keepRecent);

    if (toSummarize.length < 2) return; // Not enough to summarize

    // Ensure recent starts with a user message (required by API)
    let startIdx = 0;
    for (let j = 0; j < recent.length; j++) {
      if (recent[j].role === "user") { startIdx = j; break; }
    }
    const recentTrimmed = recent.slice(startIdx);

    // Serialize old messages into a compact text representation
    const serialized = this.serializeMessages(toSummarize);
    // Cap at ~80k chars to fit in the summarizer's context window
    const capped = serialized.length > 80000
      ? serialized.slice(0, 80000) + "\n\n[... truncated ...]"
      : serialized;

    // Extract the original task text for the summarizer
    const taskText = typeof first.content === "string"
      ? first.content
      : (first.content as ContentBlock[]).filter(b => b.type === "text").map(b => b.text).join("\n");

    // Try LLM-based summarization using the cheap executor model
    try {
      const summaryModelSpec = this.deps.router.resolveModelForRole("executor");
      const summaryResponse = await this.deps.router.chat({
        modelSpec: summaryModelSpec,
        model: summaryModelSpec.split("/").slice(1).join("/"),
        system: `You are summarizing an AI coding agent's conversation so it can continue working from the summary. The agent's original task is:\n\n${taskText}\n\nProduce a thorough, structured summary that preserves everything the agent needs to continue effectively. Include:\n- Files read, created, or modified (with full paths)\n- Key content discovered in files (important code patterns, configs, data structures)\n- Decisions made and their rationale\n- Tool results that informed those decisions (include concrete values, not just "looked at X")\n- Errors encountered and how they were resolved\n- Current state of progress toward the task\n\nBe specific and factual. Preserve file paths, function/class names, variable values, command outputs, and any data the agent extracted. The agent will NOT have access to the original messages — only your summary and the most recent exchanges.`,
        messages: [
          {
            role: "user",
            content: `Summarize this agent conversation (${toSummarize.length} messages) so the agent can continue its work:\n\n${capped}`,
          },
        ],
        maxTokens: 4096,
      });

      const summary = summaryResponse.content;
      log.info(`Agent ${this.id.slice(0, 8)}: compacted ${toSummarize.length} messages into ${summary.length}-char summary (${reason})`);

      const summaryMsg: Message = {
        role: "user",
        content: `[Conversation summary — the following is an LLM-generated summary of ${toSummarize.length} earlier messages that were compacted to stay within the context window]\n\n${summary}\n\n[End of summary — the most recent messages follow verbatim. Continue your work from where you left off.]`,
      };

      this.messages = [first, summaryMsg, ...recentTrimmed];
      this.sanitizeMessages();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Agent ${this.id.slice(0, 8)}: summarization failed (${msg}), falling back to hard truncation`);
    }

    // Fallback: hard truncation without summary
    const fallbackNote: Message = {
      role: "user",
      content: `[System note: ${toSummarize.length} older messages were removed to fit within the context window. The original task and most recent work are preserved. Continue from where you left off.]`,
    };
    this.messages = [first, fallbackNote, ...recentTrimmed];
    this.sanitizeMessages();
  }

  /**
   * Ensure every tool_result has a matching tool_use in a preceding assistant message.
   * After compaction, orphaned tool_results cause permanent 400 errors.
   */
  private sanitizeMessages(): void {
    // Collect all tool_use IDs from assistant messages
    const toolUseIds = new Set<string>();
    for (const msg of this.messages) {
      if (msg.role !== "assistant" || typeof msg.content === "string") continue;
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "tool_use" && block.id) {
          toolUseIds.add(block.id);
        }
      }
    }

    // Strip user messages that contain only orphaned tool_results
    this.messages = this.messages.filter((msg) => {
      if (msg.role !== "user" || typeof msg.content === "string") return true;
      const blocks = msg.content as ContentBlock[];
      const hasToolResults = blocks.some(b => b.type === "tool_result");
      if (!hasToolResults) return true;

      // Keep only tool_result blocks whose tool_use_id exists
      const validBlocks = blocks.filter(
        (b) => b.type !== "tool_result" || (b.tool_use_id && toolUseIds.has(b.tool_use_id)),
      );
      if (validBlocks.length === 0) return false; // Drop the entire message
      (msg as any).content = validBlocks;
      return true;
    });
  }

  /**
   * Emergency truncation: when the conversation is already minimal (≤5 messages)
   * but still overflows, aggressively truncate large tool_result content blocks.
   */
  private truncateLargeBlocks(): void {
    const MAX_BLOCK = 20_000; // chars per content block
    let truncated = 0;
    for (const msg of this.messages) {
      if (typeof msg.content === "string") {
        if (msg.content.length > MAX_BLOCK) {
          msg.content = msg.content.slice(0, MAX_BLOCK) + "\n\n[... truncated to fit context window ...]";
          truncated++;
        }
        continue;
      }
      const blocks = msg.content as ContentBlock[];
      for (const block of blocks) {
        if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > MAX_BLOCK) {
          block.content = block.content.slice(0, MAX_BLOCK) + "\n\n[... truncated to fit context window ...]";
          truncated++;
        }
        if (block.type === "text" && block.text && block.text.length > MAX_BLOCK) {
          block.text = block.text.slice(0, MAX_BLOCK) + "\n\n[... truncated to fit context window ...]";
          truncated++;
        }
      }
    }
    if (truncated > 0) {
      log.info(`Agent ${this.id.slice(0, 8)}: emergency truncation — ${truncated} blocks capped at ${MAX_BLOCK} chars`);
    }
  }

  /** Serialize messages to a compact text format for the summarizer */
  private serializeMessages(msgs: Message[]): string {
    const lines: string[] = [];
    for (const msg of msgs) {
      if (typeof msg.content === "string") {
        lines.push(`[${msg.role}] ${msg.content}`);
      } else {
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === "text" && block.text) {
            lines.push(`[${msg.role}] ${block.text}`);
          } else if (block.type === "tool_use") {
            const argsStr = JSON.stringify(block.input ?? {});
            const argsCapped = argsStr.length > 2000 ? argsStr.slice(0, 2000) + "…" : argsStr;
            lines.push(`[tool_call] ${block.name}(${argsCapped})`);
          } else if (block.type === "tool_result") {
            const content = block.content ?? "";
            const capped = content.length > 4000 ? content.slice(0, 4000) + "…" : content;
            lines.push(`[tool_result${block.is_error ? " ERROR" : ""}] ${capped}`);
          }
        }
      }
    }
    return lines.join("\n");
  }

  /** Return a lightweight conversation log for UI inspection */
  getConversationLog(maxEntries = 50): ConversationLogEntry[] {
    const entries: ConversationLogEntry[] = [];
    for (const msg of this.messages) {
      if (typeof msg.content === "string") {
        entries.push({ role: msg.role, type: "text", text: msg.content.slice(0, 2000) });
      } else {
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === "text" && block.text) {
            entries.push({ role: msg.role, type: "thinking", text: block.text.slice(0, 2000) });
          } else if (block.type === "tool_use") {
            const argStr = JSON.stringify(block.input ?? {});
            entries.push({
              role: "assistant",
              type: "tool_call",
              tool: block.name ?? "?",
              args: argStr.length > 500 ? argStr.slice(0, 500) + "…" : argStr,
            });
          } else if (block.type === "tool_result") {
            const content = block.content ?? "";
            entries.push({
              role: "user",
              type: "tool_result",
              tool: block.tool_use_id ?? "?",
              text: content.length > 1000 ? content.slice(0, 1000) + "…" : content,
              isError: block.is_error,
            });
          }
        }
      }
    }
    return entries.slice(-maxEntries);
  }

  // --- Rogue detection ---

  /**
   * Cheap pattern check: detect if the agent is making the exact same tool calls
   * (same tools AND same arguments) repeatedly without progress.
   */
  private isSpinning(): boolean {
    const history = this.iterationToolCalls;
    const windowSize = 8;
    if (history.length < windowSize) return false;

    const recent = history.slice(-windowSize);
    const pattern = [...recent[0]!].sort().join("|");

    return recent.every((calls) => [...calls].sort().join("|") === pattern);
  }

  /**
   * LLM-based rogue judge: a separate model reviews the agent's recent activity
   * and decides whether it's making meaningful progress or is stuck/looping.
   */
  private async judgeProgress(
    task: TaskAssignment,
    iteration: number,
  ): Promise<{ rogue: boolean; reason: string; partialResult?: string }> {
    try {
      // Build a compact summary of recent activity for the judge
      const recentMessages = this.messages.slice(-20); // Last ~10 exchanges
      const activitySummary = recentMessages
        .map((m) => {
          if (typeof m.content === "string") {
            return `[${m.role}] ${m.content.slice(0, 300)}`;
          }
          const blocks = m.content as ContentBlock[];
          return blocks
            .map((b) => {
              if (b.type === "text") return `[${m.role}] ${b.text?.slice(0, 200)}`;
              if (b.type === "tool_use") return `[tool_call] ${b.name}(${JSON.stringify(b.input).slice(0, 150)})`;
              if (b.type === "tool_result") return `[tool_result] ${(b.content ?? "").slice(0, 200)}`;
              return "";
            })
            .filter(Boolean)
            .join("\n");
        })
        .join("\n");

      // Tool call history summary
      const toolHistory = this.iterationToolCalls
        .slice(-15)
        .map((calls, idx) => `  ${iteration - 15 + idx + 1}: ${calls.map((c) => c.split("(")[0]).join(", ")}`)
        .join("\n");

      const judgePrompt = `You are a rogue agent detector. An AI agent has been working on a task for ${iteration} iterations. Review its recent activity and decide if it is:

1. **Making progress** — exploring new files, writing code, fixing errors, getting closer to the goal
2. **Stuck/looping** — repeating the same actions, reading the same files, retrying failed approaches without changes, going in circles

IMPORTANT: Reading many different files, listing directories, and gathering information is NORMAL and expected behavior, especially in early iterations. This is how agents understand a codebase before acting. Only flag as rogue if you see the SAME files being read repeatedly or truly circular patterns with no new information being gathered.

## Task
${task.goal}

## Recent Tool Call Pattern (last 15 iterations)
${toolHistory}

## Recent Activity (last 10 exchanges)
${activitySummary}

## Your Verdict
Respond with ONLY a JSON object:
{"rogue": false, "reason": "brief explanation"}
or
{"rogue": true, "reason": "brief explanation of why the agent is stuck", "partialResult": "summary of useful work done so far"}`;

      const modelSpec = this.deps.router.resolveModelForRole("executor");
      const response = await this.deps.router.chat({
        modelSpec,
        model: modelSpec.split("/").slice(1).join("/"),
        system: "You are a concise judge. Respond with only valid JSON.",
        messages: [{ role: "user", content: judgePrompt }],
        maxTokens: 512,
      });

      const text = response.content.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          rogue: !!parsed.rogue,
          reason: parsed.reason ?? "unknown",
          partialResult: parsed.partialResult,
        };
      }

      return { rogue: false, reason: "Judge response unparseable — continuing" };
    } catch (err) {
      log.warn(`Rogue judge error: ${err instanceof Error ? err.message : String(err)}`);
      return { rogue: false, reason: "Judge failed — continuing by default" };
    }
  }

  // --- Tool execution ---

  private async executeTool(tc: ToolCallResult): Promise<unknown> {
    // Handle synthetic read_stash tool
    if (tc.name === "read_stash") {
      const input = tc.input as Record<string, unknown>;
      const path = String(input.path ?? "");
      const offset = Number(input.offset ?? 0);
      const length = Number(input.length ?? 10000);
      try {
        const result = readStash(path, offset, length);
        return `[${result.offset}..${result.offset + result.length} of ${result.totalSize} chars]\n${result.content}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Find which service owns this tool
    const allTools = this.deps.runtime.getAllTools();
    const match = allTools.find((t) => t.name === tc.name);

    if (!match) {
      // Tool not found — emit blocked
      if (this.task) {
        await this.emitBlocked(`Tool "${tc.name}" not found`, tc.name);
      }
      return `Error: tool "${tc.name}" not found in any registered service`;
    }

    try {
      return await this.deps.runtime.callTool(
        match.service,
        tc.name,
        tc.input as Record<string, unknown>,
      );
    } catch (err) {
      return `Error executing "${tc.name}": ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // --- Helpers ---

  private getToolSchemas(): ToolSchema[] {
    const allTools = this.deps.runtime.getAllTools();
    const allowed = this.config.tools;

    const schemas = allTools
      .filter((t) => !allowed || allowed.length === 0 || allowed.includes(t.service))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

    // Synthetic tool: read_stash — available to all agents
    schemas.push({
      name: "read_stash",
      description: "Read a portion of a stashed large tool result. When a tool result is too large for the context window, it gets saved to a file and you receive a stash pointer instead. Use this tool to read sections of that file selectively.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the stashed file (provided in the stash pointer message)" },
          offset: { type: "number", description: "Character offset to start reading from (default: 0)" },
          length: { type: "number", description: "Number of characters to read (default: 10000)" },
        },
        required: ["path"],
      },
    });

    return schemas;
  }

  protected buildInitialPrompt(task: TaskAssignment): string {
    let prompt = `## Task\n\n${task.goal}`;
    if (task.context) prompt += `\n\n## Context\n\n${task.context}`;
    if (task.branch) prompt += `\n\nWork on branch: \`${task.branch}\``;

    // Inject project context
    const proj = this.deps.config.project;
    if (proj.root) {
      prompt += `\n\n## Project`;
      prompt += `\nRoot: ${proj.root}`;
      if (proj.venv) prompt += `\nPython venv: ${proj.venv} (use ${proj.venv}/bin/python to run Python)`;
      if (proj.description) prompt += `\n${proj.description}`;
      prompt += `\n\nAll file paths should be absolute (e.g. ${proj.root}/src/...).`;
      prompt += `\nUse \`cwd: "${proj.root}"\` when running shell commands.`;
    }

    prompt += `\n\n## Environment`;
    prompt += `\nYou are running inside a confined container with FULL, UNRESTRICTED access to the filesystem, shell, and git.`;
    prompt += `\nYou can read, write, and execute anything. There are no sandboxing restrictions.`;
    prompt += `\nUse your tools (read_file, write_file, list_dir, search_files, run_command, etc.) to inspect and modify files directly.`;
    prompt += `\nDo NOT claim you lack access. If a tool call fails, fix the path or arguments and retry.`;

    // Skill system instructions
    prompt += `\n\n## Skills`;
    prompt += `\nYou have access to a skill management system. Skills are reusable instruction files (SKILL.md) that teach agents how to perform specific tasks.`;
    prompt += `\n\n**Available tools:**`;
    prompt += `\n- \`list_skills\`: See all available skills`;
    prompt += `\n- \`read_skill\`: Read a skill's full content`;
    prompt += `\n- \`create_skill\`: Create a new skill from learned knowledge`;
    prompt += `\n- \`update_skill\`: Improve an existing skill`;
    prompt += `\n\n**When to create skills:**`;
    prompt += `\nWhen you discover reusable patterns, best practices, debugging techniques, or workflows that future agents would benefit from, create a skill using \`create_skill\`. Skills are automatically loaded for matching future tasks.`;
    prompt += `\n\n**Skill format:** A SKILL.md file with YAML frontmatter (name, description, version, triggers, agentTypes) followed by markdown instructions.`;
    prompt += `\n\nExample frontmatter:`;
    prompt += `\n\`\`\``;
    prompt += `\n---`;
    prompt += `\nname: api-testing`;
    prompt += `\ndescription: Best practices for testing REST APIs`;
    prompt += `\nversion: 0.1.0`;
    prompt += `\ntriggers: [api, rest, endpoint, http]`;
    prompt += `\nagentTypes: [coder, researcher]`;
    prompt += `\n---`;
    prompt += `\n\`\`\``;

    // Planning documents instructions
    const planDocsPath = this.deps.config.autonomy?.planDocsPath;
    const projRoot = this.deps.config.project?.root;
    if (planDocsPath && projRoot) {
      const planDir = `${projRoot}/${planDocsPath}`;
      prompt += `\n\n## Planning Documents`;
      prompt += `\nThe project maintains living planning documents in \`${planDir}/\`.`;
      prompt += `\nWhen relevant to your work:`;
      prompt += `\n- **journal.md**: Append entries about what you tried, what worked/didn't, and key findings.`;
      prompt += `\n  Format: \`## YYYY-MM-DD — [brief title]\\n[details]\\n---\``;
      prompt += `\n- **exploration.md**: Add new ideas, hypotheses, or investigation lines you discover.`;
      prompt += `\nDo NOT modify objectives.md, long-term-plan.md, or short-term-plan.md — those are managed by the planner.`;
      prompt += `\nKeep journal entries concise but informative. Focus on insights and learnings, not just activity logs.`;
    }

    return prompt;
  }

  // --- Event emission ---

  private async emitProgress(
    iteration: number,
    summary: string,
  ): Promise<void> {
    if (!this.task) return;
    const data: AgentProgressEvent = {
      agentId: this.id,
      taskId: this.task.id,
      iteration,
      summary,
    };
    await this.deps.eventBus.emit("agent:progress", data);
  }

  private async emitCompleted(result: string): Promise<void> {
    if (!this.task) return;
    const data: AgentCompletedEvent = {
      agentId: this.id,
      taskId: this.task.id,
      result,
    };
    await this.deps.eventBus.emit("agent:completed", data);
  }

  private async emitFailed(error: string, iteration: number): Promise<void> {
    if (!this.task) return;
    const data: AgentFailedEvent = {
      agentId: this.id,
      taskId: this.task.id,
      error,
      iteration,
    };
    await this.deps.eventBus.emit("agent:failed", data);
  }

  private async emitBlocked(
    reason: string,
    missingTool?: string,
  ): Promise<void> {
    if (!this.task) return;
    const data: AgentBlockedEvent = {
      agentId: this.id,
      taskId: this.task.id,
      reason,
      missingTool,
    };
    await this.deps.eventBus.emit("agent:blocked", data);
  }
}
