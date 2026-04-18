import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocketPlugin from "@fastify/websocket";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocketChannel } from "../channels/websocket.js";
import { ChatAgent } from "../agents/chat.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { ModelRouter } from "../providers/router.js";
import type { EventBus } from "../orchestrator/eventBus.js";
import type { SaivageConfig } from "../config.js";
import {
  queryLatestSystem,
  querySystemSummary,
  querySystemMetrics,
  queryLlmSummary,
  queryLlmMetrics,
} from "../telemetry/metrics.js";
import { log } from "../log.js";

export interface ServerOptions {
  host: string;
  port: number;
  config: SaivageConfig;
  router: ModelRouter;
  orchestrator: Orchestrator;
  eventBus: EventBus;
}

export async function createServer(opts: ServerOptions) {
  const app = Fastify({ logger: false });

  await app.register(websocketPlugin);

  // Health check
  app.get("/health", async () => {
    const state = opts.orchestrator.getState();
    return {
      status: "ok",
      todos: state.todos.length,
      activeAgents: state.activeAgents.length,
    };
  });

  // State endpoint
  app.get("/api/state", async () => {
    return opts.orchestrator.getState();
  });

  // Agent conversation log endpoint
  app.get("/api/agents/:id/log", async (request, reply) => {
    const { id } = request.params as { id: string };
    const logData = opts.orchestrator.getAgentLog(id);
    if (!logData) {
      return reply.code(404).send({ error: "Agent not found or not running" });
    }
    return logData;
  });

  // Planning data endpoint
  app.get("/api/plan", async () => {
    const data = opts.orchestrator.getPlanData();
    if (!data) return { error: "No plan configured" };
    return data;
  });

  // Stage plan endpoint
  app.get("/api/plan/stages/:id", async (request) => {
    const { id } = request.params as { id: string };
    const plan = opts.orchestrator.getStagePlan(Number(id));
    return plan ?? { error: "Stage not found" };
  });

  // Telemetry endpoints
  app.get("/api/telemetry/system", async (request) => {
    const { minutes } = request.query as { minutes?: string };
    const mins = Number(minutes) || 60;
    const toTs = Math.floor(Date.now() / 1000);
    const fromTs = toTs - mins * 60;
    return {
      current: queryLatestSystem(),
      summary: querySystemSummary({ fromTs, toTs }),
      history: (querySystemMetrics({ fromTs, toTs, limit: 500 }) as unknown[]).reverse(),
    };
  });

  app.get("/api/telemetry/llm", async (request) => {
    const { minutes, model } = request.query as { minutes?: string; model?: string };
    const mins = Number(minutes) || 60;
    const toTs = Math.floor(Date.now() / 1000);
    const fromTs = toTs - mins * 60;
    return {
      summary: queryLlmSummary({ fromTs, toTs }),
      history: (queryLlmMetrics({ fromTs, toTs, model, limit: 500 }) as unknown[]).reverse(),
    };
  });

  // WebSocket chat endpoint
  app.register(async (fastify) => {
    fastify.get("/ws", { websocket: true }, (socket, _req) => {
      log.info("WebSocket client connected");

      const channel = new WebSocketChannel(socket);
      const chat = new ChatAgent({
        channel,
        router: opts.router,
        orchestrator: opts.orchestrator,
        eventBus: opts.eventBus,
        config: opts.config,
      });

      chat.start();
      channel.onClose(() => {
        chat.stop();
        log.info("WebSocket client disconnected");
      });
    });
  });

  // Serve static web frontend if built
  // tsup bundles everything into dist/index.js, so import.meta.dirname = <root>/dist
  const webDist = join(import.meta.dirname, "../web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      wildcard: false,
    });

    // SPA fallback — serve index.html for non-API routes
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile("index.html");
    });
  }

  return app;
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const app = await createServer(opts);

  await app.listen({ host: opts.host, port: opts.port });
  log.info(`Server listening on http://${opts.host}:${opts.port}`);
  log.info(`WebSocket: ws://${opts.host}:${opts.port}/ws`);
}
