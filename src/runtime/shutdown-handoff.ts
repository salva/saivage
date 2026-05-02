/**
 * Saivage — Shutdown handoff
 * Persists an operator-supplied shutdown reason plus runtime state so the next
 * Planner session can understand why work stopped.
 */

import {
  PlanHistorySchema,
  PlanSchema,
  RuntimeStateSchema,
  ShutdownRequestSchema,
  ShutdownSummarySchema,
  type ShutdownSummary,
} from "../types.js";
import type { ProjectContext } from "../store/project.js";
import { deleteDoc, readDocOrNull, writeDoc } from "../store/documents.js";
import { log } from "../log.js";
import type { z, ZodTypeAny } from "zod";

const DEFAULT_SHUTDOWN_REASON = "Graceful shutdown requested without an external reason.";

export function writeShutdownRequest(
  project: ProjectContext,
  reason: string,
  requestedBy = "external",
): void {
  writeDoc(project.paths.shutdownRequest, {
    reason,
    requested_by: requestedBy,
    requested_at: new Date().toISOString(),
  }, ShutdownRequestSchema);
}

export function writeShutdownSummary(project: ProjectContext): ShutdownSummary {
  const shutdownStartedAtMs = Date.now();
  const shutdownStartedAt = new Date(shutdownStartedAtMs).toISOString();
  const request = readOptionalDoc(project.paths.shutdownRequest, ShutdownRequestSchema, "shutdown request");
  const runtimeState = readOptionalDoc(project.paths.runtimeState, RuntimeStateSchema, "runtime state");
  const plan = readOptionalDoc(project.paths.plan, PlanSchema, "plan");
  const history = readOptionalDoc(project.paths.planHistory, PlanHistorySchema, "plan history");
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
    current_stage_id: runtimeState?.current_stage_id ?? plan?.current_stage_id ?? null,
    active_agents: (runtimeState?.active_agents ?? []).map((agent) => {
      const startedAtMs = Date.parse(agent.started_at);
      return {
        ...agent,
        elapsed_ms: Number.isFinite(startedAtMs) ? completedAtMs - startedAtMs : null,
      };
    }),
    plan: plan ? {
      current_stage_id: plan.current_stage_id,
      pending_stages: plan.stages.length,
      history_stages: history?.stages.length ?? 0,
    } : null,
  };

  writeDoc(project.paths.shutdownSummary, summary, ShutdownSummarySchema);
  if (request) deleteDoc(project.paths.shutdownRequest);
  log.info(`[shutdown] Saved shutdown summary: ${reason}`);
  return summary;
}

export function consumeShutdownHandoff(project: ProjectContext): string | null {
  const summary = readOptionalDoc(project.paths.shutdownSummary, ShutdownSummarySchema, "shutdown summary");
  if (summary) {
    deleteDoc(project.paths.shutdownSummary);
    return formatShutdownSummaryForPlanner(summary);
  }

  const request = readOptionalDoc(project.paths.shutdownRequest, ShutdownRequestSchema, "shutdown request");
  if (!request) return null;
  deleteDoc(project.paths.shutdownRequest);
  return (
    `SYSTEM RESTART HANDOFF: A shutdown/restart was requested before the previous process could save a full shutdown summary.\n\n` +
    `Requested at: ${request.requested_at}\n` +
    `Requested by: ${request.requested_by}\n` +
    `Reason: ${request.reason}\n\n` +
    `On this restart, call plan_get() and plan_get_history(), assume the previous in-memory work was interrupted, and continue from persisted state.`
  );
}

function readOptionalDoc<S extends ZodTypeAny>(
  path: string,
  schema: S,
  label: string,
): z.output<S> | null {
  try {
    return readDocOrNull(path, schema);
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
