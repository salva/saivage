import type { WebSocket } from "ws";
import { ChatAgent } from "../agents/chat.js";
import { WebSocketChannel } from "../channels/websocket.js";
import { chatSessionId, agentId } from "../ids.js";
import { log } from "../log.js";
import type { BaseAgent } from "../agents/base.js";
import type { AgentContext } from "../agents/types.js";
import type { EventBus } from "../events/bus.js";
import type { SaivageConfig } from "../config.js";
import type { ResolvedModelRoute } from "../routing/resolver.js";
import type { PlannerControl } from "./bootstrap.js";

export interface ChatCommands {
  startWebSocketChat(socket: WebSocket): Promise<void>;
}

export interface ChatCommandRuntime {
  project: AgentContext["project"];
  router: AgentContext["router"];
  mcpRuntime: AgentContext["mcpRuntime"];
  noteManager: AgentContext["noteManager"];
  routing: { resolve(role: "chat"): ResolvedModelRoute };
  config: Pick<SaivageConfig, "notifications">;
  eventBus: EventBus;
  plannerControl: PlannerControl;
  agentRegistry: Map<string, BaseAgent>;
}

export function createChatCommands(runtime: ChatCommandRuntime): ChatCommands {
  return {
    async startWebSocketChat(socket) {
      const sessionId = chatSessionId();
      const channel = new WebSocketChannel(socket);
      const route = runtime.routing.resolve("chat");
      const ctx = {
        project: runtime.project,
        router: runtime.router,
        mcpRuntime: runtime.mcpRuntime,
        noteManager: runtime.noteManager,
        agentId: agentId(),
        role: "chat" as const,
        channelId: "web",
        sessionId,
        modelSpec: route.modelSpec,
        authProfileKey: route.authProfile,
        accountRef: route.accountRef,
      };

      const filters = runtime.config.notifications.filters;
      const chatAgent = await ChatAgent.create(
        ctx,
        { channel: "web", sessionId },
        channel,
        runtime.eventBus,
        {
          minSeverity: filters.min_severity,
          allowedTypes: filters.categories.length ? filters.categories : undefined,
        },
        runtime.plannerControl,
      );

      channel.sendEvent({ type: "session", sessionId });
      log.info(`[server] WebSocket chat session started: ${sessionId}`);

      runtime.agentRegistry.set(ctx.agentId, chatAgent);
      void (async () => {
        try {
          await chatAgent.run();
        } catch (err) {
          log.error(`[server] Chat agent error: ${err}`);
        } finally {
          runtime.agentRegistry.delete(ctx.agentId);
        }
      })();
    },
  };
}
