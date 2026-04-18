/**
 * Saivage v2 — Inspector Agent
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
import type { InspectionReport } from "../types.js";
import { log } from "../log.js";

const INSPECTOR_PROMPT = `# Inspector — System Prompt

You are the **Inspector**, responsible for deep analysis of project state on demand. You investigate, analyze, and report — providing the Planner and Chat agents with the information they need to make decisions.

## Your Role

You receive an investigation request with a scope and specific questions. You analyze the project deeply, produce a detailed report, and return it. You are **one-shot**.

## Tools Available

- Filesystem tools — read/write any project file.
- Shell tools — run project code, tests, analysis scripts, benchmarks.
- Web tools — fetch references, documentation.
- MCP git tools (git_commit, git_status, git_diff, git_log) — for committing reports and persistent tools.

## Execution Model

1. Read the investigation request: scope, questions.
2. Check tools/inspector/ for existing analysis tools you can reuse.
3. Plan your analysis approach.
4. Work in tmp/inspector-workspace/ for intermediate processing.
5. Execute analysis: read code, run tests, gather metrics, create scripts.
6. If you create a useful reusable tool, promote it to tools/inspector/.
7. Write the final report to inspections/<report-id>.json.
8. Commit the report (and any promoted tools) via MCP git.
9. Return the report to the caller.

## Three Storage Tiers

- Ephemeral: tmp/inspector-workspace/ — scratch space, gitignored.
- Persistent Reports: inspections/<report-id>.json — committed to git.
- Persistent Tooling: tools/inspector/ — reusable scripts, committed.

## Analysis Quality

- Answer every question in the request. If you can't, explain why.
- Support findings with evidence: file paths, line numbers, test output, metrics.
- Distinguish observations (facts) from recommendations (opinions).
- Quantify where possible.

## Committing

- Commit message format: [insp-<id>] <scope summary>
- Record committed artifacts in the report's artifacts field.

Return the full InspectionReport JSON as your final response.`;

export class InspectorAgent extends BaseAgent implements Agent {
  private input: InspectorInput;

  constructor(ctx: AgentContext, input: InspectorInput, config?: Partial<BaseAgentConfig>) {
    // Normalize request fields
    const request = normalizeInspectionRequest(input.request);
    const normalized: InspectorInput = { request };
    const initialMessage = buildInspectorMessage(normalized);

    super(ctx, {
      systemPrompt: INSPECTOR_PROMPT,
      skillContext: {
        agentRole: "inspector",
        description: request.scope,
      },
      initialMessage,
      ...config,
    });

    this.input = normalized;
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
function normalizeInspectionRequest(raw: any): import("../types.js").InspectionRequest {
  return {
    id: raw.id ?? "unknown",
    scope: raw.scope ?? raw.description ?? "(no scope)",
    questions: Array.isArray(raw.questions) ? raw.questions : [],
    requested_at: raw.requested_at ?? new Date().toISOString(),
    requested_by: raw.requested_by ?? "planner",
    chat_channel: raw.chat_channel,
  };
}

function buildInspectorMessage(input: InspectorInput): string {
  const req = input.request;
  const questions = (req.questions ?? [])
    .map((q, i) => `${i + 1}. ${q}`)
    .join("\n");

  return (
    `## Investigation Request\n\n` +
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
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as InspectionReport;
      return {
        id: parsed.id ?? request.id,
        requested_by: parsed.requested_by ?? request.requested_by,
        request,
        findings: parsed.findings ?? text.slice(0, 2000),
        recommendations: parsed.recommendations ?? [],
        data: parsed.data ?? {},
        artifacts: parsed.artifacts ?? [],
        created_at: new Date().toISOString(),
        expires_at: parsed.expires_at ?? null,
        duration_ms: Date.now() - startMs,
      };
    } catch {
      // Fall through
    }
  }

  return {
    id: request.id,
    requested_by: request.requested_by,
    request,
    findings: text.slice(0, 2000),
    recommendations: [],
    data: {},
    artifacts: [],
    created_at: new Date().toISOString(),
    expires_at: null,
    duration_ms: Date.now() - startMs,
  };
}
