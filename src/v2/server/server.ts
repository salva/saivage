/**
 * Saivage v2 — Web Server
 * Fastify HTTP + WebSocket server exposing v2 plan/stage/task state,
 * chat via WebSocket, and telemetry endpoints.
 */

import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import type { SaivageV2Runtime } from "./bootstrap.js";
import { readDocOrNull, listDocs } from "../store/documents.js";
import {
  PlanSchema,
  PlanHistorySchema,
  RuntimeStateSchema,
  TaskListSchema,
  StageSummarySchema,
  TaskReportSchema,
  InspectionReportSchema,
} from "../types.js";
import { ChatAgent } from "../agents/chat.js";
import { chatSessionId, agentId } from "../ids.js";
import { WebSocketChannel } from "../../channels/websocket.js";
import { log } from "../../log.js";

export interface ServerOptions {
  port: number;
  host: string;
}

export async function startServer(
  runtime: SaivageV2Runtime,
  options: ServerOptions = { port: 4800, host: "0.0.0.0" },
): Promise<{ close: () => Promise<void> }> {
  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);

  // Serve Vue SPA from web/dist/
  const webDistPath = join(
    import.meta.dirname ?? __dirname,
    "..",
    "..",
    "..",
    "web",
    "dist",
  );
  await app.register(fastifyStatic, {
    root: webDistPath,
    prefix: "/",
    wildcard: false,
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

    const tasks = readDocOrNull(
      join(stageDir, "tasks.json"),
      TaskListSchema,
    );
    const summary = readDocOrNull(
      join(stageDir, "summary.json"),
      StageSummarySchema,
    );

    // Load task reports
    const reportsDir = join(stageDir, "reports");
    const reportFiles = listDocs(reportsDir);
    const reports = reportFiles.map((f) =>
      readDocOrNull(join(reportsDir, f), TaskReportSchema),
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

function resolveModelSpec(runtime: SaivageV2Runtime): string {
  const overrides = runtime.project.config.model_overrides;
  if (overrides?.chat) return overrides.chat;
  return runtime.project.config.provider ?? "openai-codex/gpt-5.3-codex";
}

function getEventFilter(runtime: SaivageV2Runtime) {
  const filters = runtime.project.config.notifications?.filters;
  if (!filters) return undefined;
  return {
    minSeverity: filters.min_severity as "info" | "warning" | "error",
    allowedTypes: filters.categories?.length
      ? filters.categories
      : undefined,
  };
}
