/**
 * Saivage — Librarian Agent
 * Non-worker agent that curates the RAG knowledge surface. Mirrors the
 * Inspector non-worker pattern: one-shot run that delegates to
 * `BaseAgent.runLoop()` and returns an `AgentResult` directly (no
 * `TaskReport`).
 */

import { BaseAgent, type BaseAgentConfig } from "./base.js";
import type { AgentContext, AgentResult, Agent } from "./types.js";
import { loadRolePrompt } from "./prompts.js";
import { buildEagerBlock } from "../knowledge/eagerLoader.js";
import { log } from "../log.js";

export interface LibrarianInput {
  objective: string;
  collection_id?: string;
  context?: string;
}

export class LibrarianAgent extends BaseAgent implements Agent {
  private input: LibrarianInput;

  static async create(
    ctx: AgentContext,
    input: LibrarianInput,
    config?: Partial<BaseAgentConfig>,
  ): Promise<LibrarianAgent> {
    const initialMessage = buildLibrarianMessage(input);
    const eagerSkillBlock = await buildEagerBlock(
      ctx.project.projectRoot,
      "librarian",
      input.objective,
    );
    return new LibrarianAgent(ctx, input, initialMessage, eagerSkillBlock, config);
  }

  constructor(
    ctx: AgentContext,
    input: LibrarianInput,
    initialMessage: string,
    eagerSkillBlock: string,
    config?: Partial<BaseAgentConfig>,
  ) {
    super(ctx, {
      systemPrompt: loadRolePrompt("librarian"),
      eagerSkillBlock,
      skillContext: {
        agentRole: "librarian",
        description: input.objective,
      },
      initialMessage,
      ...config,
    });
    this.input = input;
  }

  async run(): Promise<AgentResult> {
    log.info(
      `[librarian:${this.id}] Starting: ${this.input.objective.slice(0, 80)}`,
    );
    try {
      const { text, finishReason } = await this.runLoop();
      if (finishReason === "abort" || finishReason === "cancelled") {
        return { kind: "abort", reason: text };
      }
      if (finishReason === "max_compactions" || finishReason === "error") {
        return { kind: "failure", reason: text };
      }
      return { kind: "success", data: text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[librarian:${this.id}] Failed: ${msg}`);
      return { kind: "failure", reason: msg };
    }
  }
}

function buildLibrarianMessage(input: LibrarianInput): string {
  const parts = [`# Objective`, input.objective];
  if (input.collection_id) parts.push(`\n# Collection`, input.collection_id);
  if (input.context) parts.push(`\n# Context`, input.context);
  return parts.join("\n");
}
