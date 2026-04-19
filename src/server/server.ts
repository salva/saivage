/**
 * Saivage — Web Server
 * Fastify HTTP + WebSocket server exposing v2 plan/stage/task state,
 * chat via WebSocket, and telemetry endpoints.
 */

import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { join, resolve } from "node:path";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import type { SaivageRuntime } from "./bootstrap.js";
import { readDocOrNull, readDocLenient, readJsonOrNull, listDocs } from "../store/documents.js";
import {
  PlanSchema,
  PlanHistorySchema,
  RuntimeStateSchema,
  TaskListSchema,
  StageSummarySchema,
  TaskReportSchema,
  InspectionReportSchema,
  ChatLogSchema,
} from "../types.js";
import { ChatAgent } from "../agents/chat.js";
import { chatSessionId, agentId } from "../ids.js";
import { WebSocketChannel } from "../channels/websocket.js";
import { log } from "../log.js";

export interface ServerOptions {
  port: number;
  host: string;
}

export async function startServer(
  runtime: SaivageRuntime,
  options: ServerOptions = { port: 8080, host: "0.0.0.0" },
): Promise<{ close: () => Promise<void> }> {
  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);

  // Serve Vue SPA from web/dist/
  // Works both from source (tsx: src/server/) and built (dist/)
  const thisDir = import.meta.dirname ?? __dirname;
  const webDistPath = thisDir.includes("/src/")
    ? join(thisDir, "..", "..", "web", "dist")
    : join(thisDir, "..", "web", "dist");
  await app.register(fastifyStatic, {
    root: webDistPath,
    prefix: "/",
    wildcard: true,
  });

  // ─── Health ─────────────────────────────────────────────────────────────

  app.get("/health", async () => {
    const state = readDocOrNull(
      runtime.project.paths.runtimeState,
      RuntimeStateSchema,
    );
    return {
      status: "ok",
      version: "2.0.0",
      project: runtime.project.config.project_name,
      runtime: state?.status ?? "unknown",
    };
  });

  // ─── Plan API ───────────────────────────────────────────────────────────

  app.get("/api/plan", async () => {
    const plan = readDocOrNull(
      runtime.project.paths.plan,
      PlanSchema,
    );
    const history = readDocOrNull(
      runtime.project.paths.planHistory,
      PlanHistorySchema,
    );
    return { plan, history };
  });

  app.get("/api/plan/stages/:id", async (req) => {
    const { id } = req.params as { id: string };
    const stageDir = join(runtime.project.paths.stages, id);

    const tasks = readDocLenient(
      join(stageDir, "tasks.json"),
      TaskListSchema,
    );
    const summary = readDocLenient(
      join(stageDir, "summary.json"),
      StageSummarySchema,
    );

    // Load task reports
    const reportsDir = join(stageDir, "reports");
    const reportFiles = listDocs(reportsDir);
    const reports = reportFiles.map((f) =>
      readDocLenient(join(reportsDir, f), TaskReportSchema),
    ).filter(Boolean);

    return { stage_id: id, tasks, summary, reports };
  });

  // ─── State API ──────────────────────────────────────────────────────────

  app.get("/api/state", async () => {
    const state = readDocOrNull(
      runtime.project.paths.runtimeState,
      RuntimeStateSchema,
    );
    const plan = readDocOrNull(
      runtime.project.paths.plan,
      PlanSchema,
    );
    return { state, plan };
  });

  // ─── Config API ─────────────────────────────────────────────────────────

  app.get("/api/config", async () => {
    const { project_name, objectives, provider } = runtime.project.config;
    return {
      project_name,
      objectives,
      provider,
    };
  });

  // ─── Inspections API ───────────────────────────────────────────────────

  app.get("/api/inspections", async () => {
    const files = listDocs(runtime.project.paths.inspections);
    const reports = files.map((f) =>
      readDocOrNull(
        join(runtime.project.paths.inspections, f),
        InspectionReportSchema,
      ),
    ).filter(Boolean);
    return { reports };
  });

  // ─── Chat Sessions API ─────────────────────────────────────────────────

  app.get("/api/chats", async () => {
    const chatsDir = runtime.project.paths.chats;
    const sessions: {
      session_id: string;
      channel: string;
      started_at: string;
      updated_at: string;
      message_count: number;
    }[] = [];

    if (!existsSync(chatsDir)) return { sessions };

    for (const channel of readdirSync(chatsDir)) {
      const channelDir = join(chatsDir, channel);
      try {
        if (!statSync(channelDir).isDirectory()) continue;
      } catch { continue; }

      for (const file of readdirSync(channelDir)) {
        if (!file.endsWith(".json")) continue;
        const chatLog = readDocOrNull(
          join(channelDir, file),
          ChatLogSchema,
        );
        if (!chatLog) continue;
        sessions.push({
          session_id: chatLog.session_id,
          channel: chatLog.channel,
          started_at: chatLog.started_at,
          updated_at: chatLog.updated_at,
          message_count: chatLog.messages.length,
        });
      }
    }

    sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return { sessions };
  });

  app.get("/api/chats/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const chatsDir = runtime.project.paths.chats;

    if (!existsSync(chatsDir)) {
      return reply.status(404).send({ error: "Not found" });
    }

    // Search across all channels
    for (const channel of readdirSync(chatsDir)) {
      const channelDir = join(chatsDir, channel);
      try {
        if (!statSync(channelDir).isDirectory()) continue;
      } catch { continue; }

      const filePath = join(channelDir, `${sessionId}.json`);
      const chatLog = readDocOrNull(filePath, ChatLogSchema);
      if (chatLog) return chatLog;
    }

    // Session may not have been persisted yet (new session, no messages)
    return { session_id: sessionId, channel: "unknown", started_at: new Date().toISOString(), updated_at: new Date().toISOString(), messages: [] };
  });

  // ─── Files API ─────────────────────────────────────────────────────────

  const HIDDEN_FILES = new Set(["auth-profiles.json"]);

  app.get("/api/files", async (req, reply) => {
    const queryPath = (req.query as { path?: string }).path ?? "";

    // Security: reject traversal attempts
    if (queryPath.includes("..") || queryPath.startsWith("/")) {
      return reply.status(400).send({ error: "Invalid path" });
    }

    const saivageDir = runtime.project.saivageDir;
    const targetDir = queryPath
      ? resolve(saivageDir, queryPath)
      : saivageDir;

    // Ensure resolved path is within .saivage/
    if (!targetDir.startsWith(saivageDir)) {
      return reply.status(400).send({ error: "Invalid path" });
    }

    if (!existsSync(targetDir)) {
      return { entries: [] };
    }

    try {
      const items = readdirSync(targetDir);
      const entries = items
        .filter((name) => !HIDDEN_FILES.has(name))
        .map((name) => {
          const fullPath = join(targetDir, name);
          try {
            const st = statSync(fullPath);
            return {
              name,
              type: st.isDirectory() ? "dir" as const : "file" as const,
              size: st.isFile() ? st.size : undefined,
              modified: st.mtime.toISOString(),
            };
          } catch {
            return { name, type: "file" as const };
          }
        });
      return { entries };
    } catch {
      return { entries: [] };
    }
  });

  app.get("/api/files/content", async (req, reply) => {
    const queryPath = (req.query as { path?: string }).path;
    if (!queryPath) {
      return reply.status(400).send({ error: "path is required" });
    }

    // Security: reject traversal attempts
    if (queryPath.includes("..") || queryPath.startsWith("/")) {
      return reply.status(400).send({ error: "Invalid path" });
    }

    const saivageDir = runtime.project.saivageDir;
    const targetFile = resolve(saivageDir, queryPath);

    if (!targetFile.startsWith(saivageDir)) {
      return reply.status(400).send({ error: "Invalid path" });
    }

    if (HIDDEN_FILES.has(queryPath.split("/").pop() ?? "")) {
      return reply.status(403).send({ error: "Access denied" });
    }

    if (!existsSync(targetFile)) {
      return reply.status(404).send({ error: "Not found" });
    }

    try {
      const st = statSync(targetFile);
      // Limit to 1MB for safety
      if (st.size > 1_048_576) {
        const partial = readFileSync(targetFile, "utf-8").slice(0, 1_048_576);
        return { path: queryPath, content: partial, size: st.size, truncated: true };
      }
      const content = readFileSync(targetFile, "utf-8");
      const ext = queryPath.split(".").pop()?.toLowerCase();
      const type = ext === "json" ? "json" : ext === "md" ? "md" : "txt";
      return { path: queryPath, content, size: st.size, type, truncated: false };
    } catch {
      return reply.status(500).send({ error: "Read failed" });
    }
  });

  // ─── Debug API ─────────────────────────────────────────────────────────

  app.get("/api/debug/state", async () => {
    const runtimeState = readDocOrNull(
      runtime.project.paths.runtimeState,
      RuntimeStateSchema,
    );
    const plan = readDocOrNull(
      runtime.project.paths.plan,
      PlanSchema,
    );
    const history = readDocOrNull(
      runtime.project.paths.planHistory,
      PlanHistorySchema,
    );

    // Read raw config files
    let saivageConfig = null;
    try {
      const saivagePath = join(runtime.project.saivageDir, "saivage.json");
      if (existsSync(saivagePath)) {
        saivageConfig = JSON.parse(readFileSync(saivagePath, "utf-8"));
      }
    } catch { /* ignore */ }

    return {
      runtime: runtimeState,
      plan,
      history,
      config: runtime.project.config,
      saivage_config: saivageConfig,
    };
  });

  app.get("/api/debug/errors", async () => {
    interface ErrorEntry {
      source: string;
      type: string;
      severity: string;
      message: string;
      details?: unknown;
      timestamp?: string;
    }
    const errors: ErrorEntry[] = [];

    // Collect from plan history
    const history = readDocOrNull(
      runtime.project.paths.planHistory,
      PlanHistorySchema,
    );
    if (history?.stages) {
      for (const stage of history.stages) {
        if (stage.result === "failed" || stage.result === "escalated") {
          errors.push({
            source: stage.id,
            type: `stage_${stage.result}`,
            severity: "error",
            message: stage.summary ?? stage.result,
            details: stage.escalation ?? stage.abort_reason ?? null,
            timestamp: stage.completed_at,
          });
        }
      }
    }

    // Collect from stage summaries and reports
    const stagesDir = runtime.project.paths.stages;
    if (existsSync(stagesDir)) {
      for (const stageId of readdirSync(stagesDir)) {
        const stageDir = join(stagesDir, stageId);
        try { if (!statSync(stageDir).isDirectory()) continue; } catch { continue; }

        // Summary issues (read raw JSON — schema may be incomplete)
        try {
          const summaryPath = join(stageDir, "summary.json");
          if (existsSync(summaryPath)) {
            const summary = JSON.parse(readFileSync(summaryPath, "utf-8"));
            if (Array.isArray(summary?.issues)) {
              for (const issue of summary.issues) {
                errors.push({
                  source: stageId,
                  type: "stage_issue",
                  severity: issue.severity ?? "warning",
                  message: issue.description ?? "Unknown issue",
                  timestamp: summary.completed_at,
                });
              }
            }
            if (summary?.result === "failed" || summary?.result === "escalated") {
              errors.push({
                source: stageId,
                type: `summary_${summary.result}`,
                severity: "error",
                message: summary.summary ?? summary.result,
                details: summary.escalation ?? null,
                timestamp: summary.completed_at,
              });
            }
          }
        } catch { /* ignore malformed summary */ }

        // Failed task reports (read raw JSON)
        const reportsDir = join(stageDir, "reports");
        if (existsSync(reportsDir)) {
          for (const f of readdirSync(reportsDir)) {
            if (!f.endsWith(".json")) continue;
            try {
              const report = JSON.parse(readFileSync(join(reportsDir, f), "utf-8"));
              if (report && report.status === "failed") {
                errors.push({
                  source: `${stageId}/${report.task_id ?? f}`,
                  type: "task_failed",
                  severity: "error",
                  message: report.failure_reason ?? report.summary ?? "Task failed",
                  details: report.issues_found,
                  timestamp: report.completed_at,
                });
              }
            } catch { /* ignore malformed report */ }
          }
        }
      }
    }

    errors.sort((a, b) =>
      (b.timestamp ?? "").localeCompare(a.timestamp ?? ""),
    );
    return { errors };
  });

  app.get("/api/debug/timeline", async () => {
    interface TimelineEvent {
      timestamp: string;
      type: string;
      source: string;
      description: string;
    }
    const events: TimelineEvent[] = [];

    // From plan history
    const history = readDocOrNull(
      runtime.project.paths.planHistory,
      PlanHistorySchema,
    );
    if (history?.stages) {
      for (const stage of history.stages) {
        if (stage.started_at) {
          events.push({
            timestamp: stage.started_at,
            type: "stage_started",
            source: stage.id,
            description: `Stage started: ${stage.objective?.slice(0, 100) ?? stage.id}`,
          });
        }
        if (stage.completed_at) {
          events.push({
            timestamp: stage.completed_at,
            type: `stage_${stage.result ?? "completed"}`,
            source: stage.id,
            description: `Stage ${stage.result}: ${stage.summary?.slice(0, 100) ?? stage.id}`,
          });
        }
      }
    }

    // From task reports (across all stages)
    const stagesDir = runtime.project.paths.stages;
    if (existsSync(stagesDir)) {
      for (const stageId of readdirSync(stagesDir)) {
        const reportsDir = join(stagesDir, stageId, "reports");
        if (!existsSync(reportsDir)) continue;
        for (const f of readdirSync(reportsDir)) {
          if (!f.endsWith(".json")) continue;
          try {
            const report = JSON.parse(readFileSync(join(reportsDir, f), "utf-8"));
            if (report?.completed_at) {
              events.push({
                timestamp: report.completed_at,
                type: `task_${report.status ?? "unknown"}`,
                source: `${stageId}/${report.task_id ?? f}`,
                description: `Task ${report.status}: ${(report.summary ?? report.task_id ?? f).slice(0, 100)}`,
              });
            }
          } catch { /* ignore malformed report */ }
        }
      }
    }

    events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return { events };
  });

  // ─── WebSocket Chat ────────────────────────────────────────────────────

  app.get("/ws", { websocket: true }, (socket, _req) => {
    const sessionId = chatSessionId();
    const channel = new WebSocketChannel(socket);

    const ctx = {
      project: runtime.project,
      router: runtime.router,
      mcpRuntime: runtime.mcpRuntime,
      agentId: agentId(),
      role: "chat" as const,
      modelSpec: resolveModelSpec(runtime),
    };

    const chatAgent = new ChatAgent(
      ctx,
      { channel: "web", sessionId },
      channel,
      runtime.eventBus,
      getEventFilter(runtime),
    );

    // Send session ID to client so it can reload messages on reconnect
    channel.sendEvent({ type: "session", sessionId });

    log.info(`[server] WebSocket chat session started: ${sessionId}`);

    // Run the chat agent (non-blocking — it runs until the socket closes)
    chatAgent.run().catch((err) => {
      log.error(`[server] Chat agent error: ${err}`);
    });
  });

  // ─── SPA Fallback ──────────────────────────────────────────────────────

  app.setNotFoundHandler(async (_req, reply) => {
    return reply.sendFile("index.html");
  });

  // ─── Start ──────────────────────────────────────────────────────────────

  await app.listen({ port: options.port, host: options.host });
  log.info(`[server] Listening on ${options.host}:${options.port}`);

  return {
    close: async () => {
      await app.close();
      log.info("[server] Server closed");
    },
  };
}

function resolveModelSpec(runtime: SaivageRuntime): string {
  // Chat-specific model from project config overrides
  const overrides = runtime.project.config.model_overrides;
  if (overrides?.chat) return overrides.chat;
  // Chat model from runtime config (saivage.json) — ideally a cheaper/faster model
  const chatModel = runtime.config.models?.chat;
  if (chatModel) return chatModel;
  // Fallback to default provider
  return runtime.project.config.provider ?? "openai-codex/gpt-5.3-codex";
}

function getEventFilter(runtime: SaivageRuntime) {
  const filters = runtime.project.config.notifications?.filters;
  if (!filters) return undefined;
  return {
    minSeverity: filters.min_severity as "info" | "warning" | "error",
    allowedTypes: filters.categories?.length
      ? filters.categories
      : undefined,
  };
}
