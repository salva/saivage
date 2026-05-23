/**
 * Saivage — Web Server
 * Fastify HTTP + WebSocket server exposing v2 plan/stage/task state,
 * chat via WebSocket, and telemetry endpoints.
 */

import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { join, resolve, relative } from "node:path";
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
import { NoteManager } from "../runtime/notes.js";

/**
 * Returns true if `target` is the same as or a descendant of `base` after
 * path resolution. `startsWith` is the wrong primitive: it would treat
 * `/foo/barx` as inside `/foo/bar`. `relative()` returns an empty string for
 * the base itself and never starts with `..` for proper descendants.
 */
export function isPathInside(base: string, target: string): boolean {
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  if (resolvedBase === resolvedTarget) return true;
  const rel = relative(resolvedBase, resolvedTarget);
  if (rel === "" || rel === ".") return true;
  if (rel.startsWith("..")) return false;
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return false;
  return true;
}

export interface ServerOptions {
  port: number;
  host: string;
}

export async function startServer(
  runtime: SaivageRuntime,
  options: ServerOptions = { port: 8080, host: "0.0.0.0" },
): Promise<{ close: () => Promise<void> }> {
  const app = Fastify({ logger: false });

  // ─── Optional API token gate ───────────────────────────────────────────
  // When SAIVAGE_API_TOKEN is set, /api/* and /ws require the same token via
  // Authorization: Bearer, x-saivage-token header, or ?token= query param.
  // /, /assets/*, /index.html and /health stay public so the SPA loads and
  // monitoring can probe.
  //
  // /api/* is enforced by an onRequest hook that returns 401. /ws is also
  // checked here, but rejecting a WebSocket upgrade with an HTTP 401 makes
  // the browser see only a generic 1006 "abnormal closure" on the WebSocket
  // side, which the SPA would treat as a transient drop and retry forever.
  // The actual /ws handler below performs a second check and closes the
  // socket with 1008 (policy violation) so the client can stop the loop.
  const apiToken = process.env["SAIVAGE_API_TOKEN"];
  if (apiToken) {
    log.info("[server] API token gate enabled (SAIVAGE_API_TOKEN set)");
    app.addHook("onRequest", async (req, reply) => {
      const url = req.url.split("?")[0] ?? "";
      if (!url.startsWith("/api/")) return;
      if (extractRequestToken(req) !== apiToken) {
        return reply.status(401).send({ error: "unauthorized" });
      }
    });
  }

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

  // Serve VitePress docs from docs/.vitepress/dist/ at /docs/.
  // The docs are built by `npm run docs:build` and are entirely optional —
  // skip mounting if the directory hasn't been built yet so the server
  // still starts in dev / fresh-checkout scenarios.
  const docsDistPath = thisDir.includes("/src/")
    ? join(thisDir, "..", "..", "docs", ".vitepress", "dist")
    : join(thisDir, "..", "docs", ".vitepress", "dist");
  if (existsSync(docsDistPath)) {
    await app.register(fastifyStatic, {
      root: docsDistPath,
      prefix: "/docs/",
      decorateReply: false,
      wildcard: true,
      index: ["index.html"],
    });
    log.info(`[server] docs mounted at /docs/ from ${docsDistPath}`);
  } else {
    log.info(`[server] docs not built (run 'npm run docs:build') — /docs/ disabled`);
    // Tiny placeholder so the dashboard link doesn't 404 silently.
    app.get("/docs/", async (_req, reply) => {
      reply.type("text/html").send(
        "<!doctype html><meta charset=\"utf-8\"><title>Saivage docs</title>" +
        "<style>body{font:14px/1.5 system-ui;margin:3rem auto;max-width:38rem;color:#222}</style>" +
        "<h1>Documentation not built</h1>" +
        "<p>Run <code>npm run docs:build</code> in the project root, then reload this page.</p>",
      );
    });
  }

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

  // ─── Agent Conversation API ─────────────────────────────────────────────

  app.get("/api/agents/:agentId/conversation", async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const agent = runtime.agentRegistry.get(agentId);
    if (agent) {
      return {
        agent_id: agentId,
        role: agent.role,
        started_at: agent.startedAt,
        message_count: agent.messageCount,
        entries: agent.getConversationSnapshot(),
        activity_status: agent.getActivityStatus(),
      };
    }

    const completed = runtime.completedAgentRegistry.get(agentId);
    if (!completed) {
      return reply.status(404).send({ error: "Agent not found or no longer running" });
    }
    return completed;
  });

  // ─── Config API ─────────────────────────────────────────────────────────

  app.get("/api/config", async () => {
    const { project_name, objectives } = runtime.project.config;
    const plannerRoute = runtime.routing.resolve("planner");
    const chatRoute = runtime.routing.resolve("chat");
    return {
      project_name,
      objectives,
      provider: plannerRoute.modelSpec,
      routing: {
        planner: plannerRoute,
        chat: chatRoute,
      },
    };
  });

  app.get("/api/providers", async () => {
    const providers = await Promise.all(runtime.router.listProviders().map(async (name) => {
      try {
        return { name, models: await runtime.router.listModels(name) };
      } catch (err) {
        return { name, models: [], error: err instanceof Error ? err.message : String(err) };
      }
    }));
    return { providers };
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

  // ─── Notes API ─────────────────────────────────────────────────────────

  app.get("/api/notes", async () => {
    const noteManager = new NoteManager(runtime.project.paths.notes);
    return { notes: noteManager.listNotes() };
  });

  app.post("/api/notes/:noteId/acknowledge", async (req, reply) => {
    const { noteId } = req.params as { noteId: string };
    const noteManager = new NoteManager(runtime.project.paths.notes);
    const result = noteManager.acknowledgeNote(noteId);
    if (!result) {
      return reply.status(404).send({ error: "Note not found" });
    }
    return result;
  });

  app.delete("/api/notes/:noteId", async (req, reply) => {
    const { noteId } = req.params as { noteId: string };
    const noteManager = new NoteManager(runtime.project.paths.notes);
    if (!noteManager.deleteNote(noteId)) {
      return reply.status(404).send({ error: "Note not found" });
    }
    return { deleted: true };
  });

  app.delete("/api/notes", async () => {
    const noteManager = new NoteManager(runtime.project.paths.notes);
    return { deleted: noteManager.clearNotes() };
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
    if (!isPathInside(saivageDir, targetDir)) {
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

    if (!isPathInside(saivageDir, targetFile)) {
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

  app.get("/ws", { websocket: true }, (socket, req) => {
    if (apiToken && extractRequestToken(req) !== apiToken) {
      log.warn("[server] WebSocket rejected: missing or invalid token");
      // 1008 = policy violation; the SPA stops reconnecting on this code.
      socket.close(1008, "unauthorized");
      return;
    }
    const sessionId = chatSessionId();
    const channel = new WebSocketChannel(socket);

    const ctx = {
      project: runtime.project,
      router: runtime.router,
      mcpRuntime: runtime.mcpRuntime,
      agentId: agentId(),
      role: "chat" as const,
      ...resolveChatRoute(runtime),
    };

    const chatAgent = new ChatAgent(
      ctx,
      { channel: "web", sessionId },
      channel,
      runtime.eventBus,
      getEventFilter(runtime),
      runtime.plannerControl,
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

function resolveChatRoute(runtime: SaivageRuntime) {
  const route = runtime.routing.resolve("chat");
  return {
    modelSpec: route.modelSpec,
    authProfileKey: route.authProfile,
    accountRef: route.accountRef,
  };
}

function bearer(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  const header = Array.isArray(value) ? value[0] : value;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}

interface RequestWithAuthBits {
  headers: Record<string, unknown>;
  query?: unknown;
}

function extractRequestToken(req: RequestWithAuthBits): string | undefined {
  const headerToken =
    (req.headers["x-saivage-token"] as string | undefined) ??
    bearer(req.headers["authorization"] as string | string[] | undefined);
  const query = req.query as { token?: string } | undefined;
  return headerToken ?? query?.token;
}
