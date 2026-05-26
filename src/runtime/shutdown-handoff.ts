/**
 * Saivage — Shutdown handoff
 * Persists an operator-supplied shutdown reason plus runtime state so the next
 * Planner session can understand why work stopped.
 */

import {
  PlanDocumentSchema,
  RuntimeStateSchema,
  ShutdownRequestSchema,
  ShutdownSummarySchema,
  type ShutdownSummary,
} from "../types.js";
import type { ProjectContext } from "../store/project.js";
import { readDocOrNull, renameDoc, writeDoc } from "../store/documents.js";
import { log } from "../log.js";
import type { z, ZodTypeAny } from "zod";

const DEFAULT_SHUTDOWN_REASON = "Graceful shutdown requested without an external reason.";

export async function writeShutdownRequest(
  project: ProjectContext,
  reason: string,
  requestedBy = "external",
): Promise<void> {
  await writeDoc(project.paths.shutdownRequest, {
    reason,
    requested_by: requestedBy,
    requested_at: new Date().toISOString(),
  }, ShutdownRequestSchema);
}

export async function writeShutdownSummary(project: ProjectContext): Promise<ShutdownSummary> {
  const shutdownStartedAtMs = Date.now();
  const shutdownStartedAt = new Date(shutdownStartedAtMs).toISOString();
  const request = await readOptionalDoc(project.paths.shutdownRequest, ShutdownRequestSchema, "shutdown request");
  const runtimeState = await readOptionalDoc(project.paths.runtimeState, RuntimeStateSchema, "runtime state");
  const planDoc = await readOptionalDoc(project.paths.plan, PlanDocumentSchema, "plan");
  const reason = request?.reason ?? DEFAULT_SHUTDOWN_REASON;
  const requestedAt = request?.requested_at ?? null;
  const runtimeStartedAtMs = runtimeState?.started_at ? Date.parse(runtimeState.started_at) : NaN;
  const completedAtMs = Date.now();

  const summary: ShutdownSummary = {
    reason,
    requested_by: request?.requested_by ?? "system",
    requested_at: requestedAt,
    shutdown_started_at: shutdownStartedAt,
    completed_at: new Date(completedAtMs).toISOString(),
    duration_ms: completedAtMs - shutdownStartedAtMs,
    pid: process.pid,
    runtime_status: runtimeState?.status ?? null,
    runtime_started_at: runtimeState?.started_at ?? null,
    runtime_updated_at: runtimeState?.updated_at ?? null,
    uptime_ms: Number.isFinite(runtimeStartedAtMs) ? completedAtMs - runtimeStartedAtMs : null,
    current_stage_id: runtimeState?.current_stage_id ?? planDoc?.current_stage_id ?? null,
    active_agents: (runtimeState?.active_agents ?? []).map((agent) => {
      const startedAtMs = Date.parse(agent.started_at);
      return {
        ...agent,
        elapsed_ms: Number.isFinite(startedAtMs) ? completedAtMs - startedAtMs : null,
      };
    }),
    plan: planDoc ? {
      current_stage_id: planDoc.current_stage_id,
      pending_stages: planDoc.stages.length,
      history_stages: planDoc.history.length,
    } : null,
  };

  await writeDoc(project.paths.shutdownSummary, summary, ShutdownSummarySchema);
  if (request) await markConsumed(project.paths.shutdownRequest);
  log.info(`[shutdown] Saved shutdown summary: ${reason}`);
  return summary;
}

export async function consumeShutdownHandoff(project: ProjectContext): Promise<string | null> {
  const summary = await readOptionalDoc(project.paths.shutdownSummary, ShutdownSummarySchema, "shutdown summary");
  if (summary) {
    await markConsumed(project.paths.shutdownSummary);
    return formatShutdownSummaryForPlanner(summary);
  }

  const request = await readOptionalDoc(project.paths.shutdownRequest, ShutdownRequestSchema, "shutdown request");
  if (!request) return null;
  await markConsumed(project.paths.shutdownRequest);
  return (
    `SYSTEM RESTART HANDOFF: A shutdown/restart was requested before the previous process could save a full shutdown summary.\n\n` +
    `Requested at: ${request.requested_at}\n` +
    `Requested by: ${request.requested_by}\n` +
    `Reason: ${request.reason}\n\n` +
    `On this restart, call plan_get() and plan_get_history(), assume the previous in-memory work was interrupted, and continue from persisted state.`
  );
}

async function readOptionalDoc<S extends ZodTypeAny>(
  path: string,
  schema: S,
  label: string,
): Promise<z.output<S> | null> {
  try {
    return await readDocOrNull(path, schema);
  } catch (err) {
    log.warn(`[shutdown] Ignoring unreadable ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function formatShutdownSummaryForPlanner(summary: ShutdownSummary): string {
  const activeAgents = summary.active_agents.length > 0
    ? summary.active_agents.map((agent) => {
        const elapsed = agent.elapsed_ms === null ? "unknown" : formatDuration(agent.elapsed_ms);
        const task = agent.current_task_id ? ` task=${agent.current_task_id}` : "";
        return `- ${agent.agent_type}:${agent.agent_id}${task}, running for ${elapsed}`;
      }).join("\n")
    : "- none";
  const uptime = summary.uptime_ms === null ? "unknown" : formatDuration(summary.uptime_ms);
  const planLine = summary.plan
    ? `Plan current stage: ${summary.plan.current_stage_id ?? "none"}; pending stages: ${summary.plan.pending_stages}; history stages: ${summary.plan.history_stages}`
    : "Plan snapshot unavailable.";

  return (
    `SYSTEM RESTART HANDOFF: The previous Saivage process shut down cleanly and saved this state summary.\n\n` +
    `External shutdown reason: ${summary.reason}\n` +
    `Requested by: ${summary.requested_by}\n` +
    `Requested at: ${summary.requested_at ?? "not provided"}\n` +
    `Shutdown started: ${summary.shutdown_started_at}\n` +
    `Shutdown completed: ${summary.completed_at}\n` +
    `Runtime status before shutdown: ${summary.runtime_status ?? "unknown"}\n` +
    `Runtime uptime before shutdown: ${uptime}\n` +
    `Current stage before shutdown: ${summary.current_stage_id ?? "none"}\n` +
    `${planLine}\n` +
    `Active agents at shutdown:\n${activeAgents}\n\n` +
    `On this restart, call plan_get() and plan_get_history(), account for the shutdown reason, and continue from persisted state. Do not assume any interrupted in-memory agent work completed unless persisted reports or plan history prove it.`
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

async function markConsumed(path: string): Promise<void> {
  await renameDoc(path, `${path}.consumed`);
}
