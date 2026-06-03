import type { FastifyInstance } from "fastify";
import { extractRequestToken } from "../auth.js";
import type { ChatCommands } from "../chat-command-service.js";
import { log } from "../../log.js";

export function registerWebSocketRoutes(
  app: FastifyInstance,
  deps: { apiToken?: string; commands: Pick<ChatCommands, "startWebSocketChat"> },
): void {
  app.get("/ws", { websocket: true }, async (socket, req) => {
    if (deps.apiToken && extractRequestToken(req) !== deps.apiToken) {
      log.warn("[server] WebSocket rejected: missing or invalid token");
      socket.close(1008, "unauthorized");
      return;
    }
    await deps.commands.startWebSocketChat(socket);
  });
}
