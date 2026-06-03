/**
 * Saivage — Web Server
 * Fastify HTTP + WebSocket server exposing v2 plan/stage/task state,
 * chat via WebSocket, and telemetry endpoints.
 */

import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import type { SaivageRuntime } from "./bootstrap.js";
import { ProjectStore } from "../store/project-store.js";
import { FileBrowserService } from "./file-browser-service.js";
import { log } from "../log.js";
import { registerApiTokenAuth } from "./auth.js";
import { registerStaticAssets } from "./static-assets.js";
import { registerNotesRoutes } from "./routes/notes.js";
import { registerFilesRoutes } from "./routes/files.js";
import { createChatCommands } from "./chat-command-service.js";
import { registerWebSocketRoutes } from "./routes/websocket.js";
import { registerHealthPlanStateRoutes } from "./routes/health-plan-state.js";
import { registerAgentConversationRoutes } from "./routes/agents.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerInspectionsChatsRoutes } from "./routes/inspections-chats.js";
import { registerDebugRoutes } from "./routes/debug.js";

export interface ServerOptions {
  port: number;
  host: string;
}

export async function startServer(
  runtime: SaivageRuntime,
  options: ServerOptions = { port: 8080, host: "0.0.0.0" },
): Promise<{ close: () => Promise<void> }> {
  const app = Fastify({ logger: false });
  const projectStore = new ProjectStore(runtime.project);
  const fileBrowser = new FileBrowserService(runtime.project);
  const chatCommands = createChatCommands(runtime);

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
  registerApiTokenAuth(app, apiToken);

  await app.register(fastifyWebsocket);
  await registerStaticAssets(app);

  registerHealthPlanStateRoutes(app, {
    reads: {
      runtimeState: projectStore.runtimeState.bind(projectStore),
      activePlanView: projectStore.activePlanView.bind(projectStore),
      planHistoryView: projectStore.planHistoryView.bind(projectStore),
      stageDetails: projectStore.stageDetails.bind(projectStore),
    },
    projectName: runtime.project.config.project_name,
  });

  // ─── Agent Conversation API ─────────────────────────────────────────────

  registerAgentConversationRoutes(app, {
    getAgent: (agentId) => runtime.agentRegistry.get(agentId),
  });

  // ─── Config API ─────────────────────────────────────────────────────────

  registerConfigRoutes(app, {
    runtime: { project: runtime.project, routing: runtime.routing },
    router: runtime.router,
    mcpRuntime: runtime.mcpRuntime,
  });

  // ─── Inspections API ───────────────────────────────────────────────────

  registerInspectionsChatsRoutes(app, {
    inspectionReports: projectStore.inspectionReports.bind(projectStore),
    chatSessions: projectStore.chatSessions.bind(projectStore),
    chatLogBySessionId: projectStore.chatLogBySessionId.bind(projectStore),
  });

  // ─── Notes API ─────────────────────────────────────────────────────────

  registerNotesRoutes(app, {
    reads: { listNotes: () => runtime.noteManager.listNotes() },
    commands: {
      acknowledgeNote: (noteId) => runtime.noteManager.acknowledgeNote(noteId),
      deleteNote: (noteId) => runtime.noteManager.deleteNote(noteId),
      clearNotes: () => runtime.noteManager.clearNotes(),
    },
  });

  // ─── Files API ─────────────────────────────────────────────────────────

  registerFilesRoutes(app, {
    list: fileBrowser.list.bind(fileBrowser),
    read: fileBrowser.read.bind(fileBrowser),
  });

  // ─── Debug API ─────────────────────────────────────────────────────────

  registerDebugRoutes(app, {
    reads: {
      runtimeState: projectStore.runtimeState.bind(projectStore),
      readPlan: projectStore.readPlan.bind(projectStore),
      debugErrors: projectStore.debugErrors.bind(projectStore),
      debugTimeline: projectStore.debugTimeline.bind(projectStore),
    },
    projectConfig: runtime.project.config,
    knowledgeStore: runtime.knowledgeStore,
  });

  // ─── WebSocket Chat ────────────────────────────────────────────────────

  registerWebSocketRoutes(app, { apiToken, commands: chatCommands });

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
