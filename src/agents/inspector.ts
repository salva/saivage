/**
 * Saivage — Inspector Agent
 * One-shot deep analysis agent. Investigates project state, produces
 * InspectionReport with findings, recommendations, metrics.
 */

import { BaseAgent, type BaseAgentConfig } from "./base.js";
import type {
  AgentContext,
  AgentResult,
  InspectorInput,
  Agent,
} from "./types.js";
import { InspectionReportSchema, type InspectionReport } from "../types.js";
import { parseLlmJsonAs } from "../parse-llm-json.js";
import { log } from "../log.js";
import { buildHandoffContext } from "./handoff.js";
import { loadRolePrompt } from "./prompts.js";
import { buildEagerBlock } from "../knowledge/eagerLoader.js";


export class InspectorAgent extends BaseAgent implements Agent {
  private input: InspectorInput;

  static async create(
    ctx: AgentContext,
    input: InspectorInput,
    config?: Partial<BaseAgentConfig>,
  ): Promise<InspectorAgent> {
    const request = normalizeInspectionRequest(input.request as unknown as Record<string, unknown>);
    const normalized: InspectorInput = { request };
    const initialMessage = await buildInspectorMessage(ctx, normalized);
    const eagerSkillBlock = await buildEagerBlock(
      ctx.project.projectRoot,
      "inspector",
      request.scope,
    );
    return new InspectorAgent(ctx, normalized, initialMessage, eagerSkillBlock, config);
  }

  constructor(
    ctx: AgentContext,
    input: InspectorInput,
    initialMessage: string,
    eagerSkillBlock: string,
    config?: Partial<BaseAgentConfig>,
  ) {
    super(ctx, {
      systemPrompt: loadRolePrompt("inspector"),
      eagerSkillBlock,
      skillContext: {
        agentRole: "inspector",
        description: input.request.scope,
      },
      initialMessage,
      ...config,
    });

    this.input = input;
  }

  async run(): Promise<AgentResult> {
    const req = this.input.request;
    log.info(
      `[inspector:${this.id}] Starting investigation ${req.id}: ${req.scope.slice(0, 80)}`,
    );

    const start = Date.now();

    try {
      const { text, finishReason } = await this.runLoop();

      if (finishReason === "abort" || finishReason === "cancelled") {
        return { kind: "abort", reason: text };
      }

      if (finishReason === "max_compactions" || finishReason === "error") {
        return { kind: "failure", reason: text };
      }

      const report = parseInspectionReport(text, req, start);
      return { kind: "success", data: report };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[inspector:${this.id}] Failed: ${msg}`);
      return { kind: "failure", reason: msg };
    }
  }
}

/** Normalize an inspection request that may have missing fields from LLM output. */
function normalizeInspectionRequest(raw: Record<string, unknown>): import("../types.js").InspectionRequest {
  return {
    id: (raw.id as string | undefined) ?? "unknown",
    scope: (raw.scope as string | undefined) ?? (raw.description as string | undefined) ?? "(no scope)",
    questions: Array.isArray(raw.questions) ? (raw.questions as string[]) : [],
    requested_at: (raw.requested_at as string | undefined) ?? new Date().toISOString(),
    requested_by: (raw.requested_by as import("../types.js").InspectionRequest["requested_by"] | undefined) ?? "planner",
    chat_channel: raw.chat_channel as import("../types.js").InspectionRequest["chat_channel"],
  };
}

async function buildInspectorMessage(ctx: AgentContext, input: InspectorInput): Promise<string> {
  const req = input.request;
  const questions = (req.questions ?? [])
    .map((q, i) => `${i + 1}. ${q}`)
    .join("\n");
  const handoffBlock = await buildHandoffContext(ctx);

  return (
    `## Investigation Request\n\n` +
    `${handoffBlock}\n\n` +
    `**Request ID:** ${req.id}\n` +
    `**Requested By:** ${req.requested_by}\n` +
    `**Requested At:** ${req.requested_at}\n\n` +
    `### Scope\n${req.scope}\n\n` +
    `### Questions\n${questions}\n\n` +
    `### Instructions\n` +
    `1. Check tools/inspector/ for reusable analysis tools.\n` +
    `2. Use tmp/inspector-workspace/ for intermediate work.\n` +
    `3. Write the report to inspections/${req.id}.json.\n` +
    `4. Commit via MCP git with message: [${req.id}] ${(req.scope ?? "").slice(0, 40)}\n` +
    `5. Return the full InspectionReport JSON as your final response.`
  );
}

function parseInspectionReport(
  text: string,
  request: InspectorInput["request"],
  startMs: number,
): InspectionReport {
  const result = parseLlmJsonAs(text, InspectionReportSchema.partial());
  if (!result.ok) {
    return {
      id: request.id,
      requested_by: request.requested_by,
      request,
      findings: `Inspector emitted ${result.reason}: ${result.detail}`,
      recommendations: [],
      data: {},
      artifacts: [],
      created_at: new Date().toISOString(),
      expires_at: null,
      duration_ms: Date.now() - startMs,
    };
  }
  const parsed = result.value;
  return {
    id: parsed.id ?? request.id,
    requested_by: parsed.requested_by ?? request.requested_by,
    request,
    findings: parsed.findings ?? "",
    recommendations: parsed.recommendations ?? [],
    data: parsed.data ?? {},
    artifacts: parsed.artifacts ?? [],
    created_at: new Date().toISOString(),
    expires_at: parsed.expires_at ?? null,
    duration_ms: Date.now() - startMs,
  };
}
