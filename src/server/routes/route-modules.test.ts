import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerAgentConversationRoutes } from "./agents.js";
import { registerConfigRoutes } from "./config.js";
import { registerHealthPlanStateRoutes } from "./health-plan-state.js";
import { registerInspectionsChatsRoutes } from "./inspections-chats.js";

describe("extracted server route modules", () => {
  it("serves health, plan, stage, and state from fake reads", async () => {
    const app = Fastify({ logger: false });
    registerHealthPlanStateRoutes(app, {
      projectName: "fixture",
      reads: {
        runtimeState: async () => ({ status: "running" }) as never,
        activePlanView: async () => ({ updated_at: "now", current_stage_id: "s1", stages: [] }),
        planHistoryView: async () => ({ stages: [] }),
        stageDetails: async (stageId) => ({ stage_id: stageId, tasks: null, summary: null, reports: [] }),
      },
    });
    await app.ready();

    try {
      expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({
        status: "ok",
        version: "2.0.0",
        project: "fixture",
        runtime: "running",
      });
      expect((await app.inject({ method: "GET", url: "/api/plan" })).json()).toEqual({
        plan: { updated_at: "now", current_stage_id: "s1", stages: [] },
        history: { stages: [] },
      });
      expect((await app.inject({ method: "GET", url: "/api/plan/stages/s1" })).json()).toEqual({
        stage_id: "s1",
        tasks: null,
        summary: null,
        reports: [],
      });
      expect((await app.inject({ method: "GET", url: "/api/state" })).json()).toEqual({
        state: { status: "running" },
        plan: { updated_at: "now", current_stage_id: "s1", stages: [] },
      });
    } finally {
      await app.close();
    }
  });

  it("serves agent conversations from a fake agent lookup", async () => {
    const app = Fastify({ logger: false });
    registerAgentConversationRoutes(app, {
      getAgent: (agentId) => agentId === "agent-1" ? {
        role: "worker",
        startedAt: "start",
        messageCount: 2,
        getConversationSnapshot: () => [{ role: "assistant", content: "hello" }],
        getActivityStatus: () => ({ state: "idle" }),
      } as never : undefined,
    });
    await app.ready();

    try {
      expect((await app.inject({ method: "GET", url: "/api/agents/missing/conversation" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/agents/agent-1/conversation" })).json()).toEqual({
        agent_id: "agent-1",
        role: "worker",
        started_at: "start",
        message_count: 2,
        entries: [{ role: "assistant", content: "hello" }],
        activity_status: { state: "idle" },
      });
    } finally {
      await app.close();
    }
  });

  it("serves config, provider, MCP, inspection, and chat routes from fake deps", async () => {
    const app = Fastify({ logger: false });
    const route = {
      role: "planner",
      modelSpec: "provider/model",
      provider: "provider",
      model: "model",
      preferredModels: ["provider/model"],
      source: "routing" as const,
    };
    registerConfigRoutes(app, {
      runtime: {
        project: {
          config: { project_name: "fixture", objectives: ["objective"] },
          projectRoot: "/project",
          saivageDir: "/project/.saivage",
        },
        routing: { resolve: (role: string) => ({ ...route, role }) },
      } as never,
      router: {
        listProviders: () => ["provider"],
        listModels: async () => ["model"],
      } as never,
      mcpRuntime: { listAllToolsForApi: () => [{ name: "tool" }] } as never,
    });
    registerInspectionsChatsRoutes(app, {
      inspectionReports: async () => [{ id: "inspection-1" }] as never,
      chatSessions: async () => [{ session_id: "chat-1", channel: "web", started_at: "a", updated_at: "b", message_count: 1 }],
      chatLogBySessionId: async (sessionId) => sessionId === "missing"
        ? { kind: "missing-root" }
        : { kind: "found", chatLog: { session_id: sessionId, channel: "web", started_at: "a", updated_at: "b", messages: [] } },
    });
    await app.ready();

    try {
      expect((await app.inject({ method: "GET", url: "/api/config" })).json()).toMatchObject({
        project_name: "fixture",
        routing: { planner: { modelSpec: "provider/model" } },
      });
      expect((await app.inject({ method: "GET", url: "/api/providers" })).json()).toEqual({
        providers: [{ name: "provider", models: ["model"] }],
      });
      expect((await app.inject({ method: "GET", url: "/api/mcp/tools" })).json()).toEqual({ tools: [{ name: "tool" }] });
      expect((await app.inject({ method: "GET", url: "/api/inspections" })).json()).toEqual({ reports: [{ id: "inspection-1" }] });
      expect((await app.inject({ method: "GET", url: "/api/chats" })).json()).toEqual({
        sessions: [{ session_id: "chat-1", channel: "web", started_at: "a", updated_at: "b", message_count: 1 }],
      });
      expect((await app.inject({ method: "GET", url: "/api/chats/chat-1" })).json()).toEqual({
        session_id: "chat-1",
        channel: "web",
        started_at: "a",
        updated_at: "b",
        messages: [],
      });
      expect((await app.inject({ method: "GET", url: "/api/chats/missing" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
