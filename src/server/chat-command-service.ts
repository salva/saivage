import type { WebSocket } from "ws";
import { ChatAgent } from "../agents/chat.js";
import { WebSocketChannel } from "../channels/websocket.js";
import { chatSessionId, agentId } from "../ids.js";
import { log } from "../log.js";
import type { SaivageRuntime } from "./bootstrap.js";

export interface ChatCommands {
  startWebSocketChat(socket: WebSocket): Promise<void>;
}

export function createChatCommands(runtime: SaivageRuntime): ChatCommands {
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
