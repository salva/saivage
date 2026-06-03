import type { FastifyInstance } from "fastify";
import type {
  ChatLogReadResult,
  ChatSessionListEntry,
} from "../../store/project-store.js";
import type { ChatLog, InspectionReport } from "../../types.js";

export interface InspectionsChatsReads {
  inspectionReports(): Promise<InspectionReport[]>;
  chatSessions(): Promise<ChatSessionListEntry[]>;
  chatLogBySessionId(sessionId: string): Promise<ChatLogReadResult>;
}

export function registerInspectionsChatsRoutes(
  app: FastifyInstance,
  reads: InspectionsChatsReads,
): void {
  app.get("/api/inspections", async () => {
    return { reports: await reads.inspectionReports() };
  });

  app.get("/api/chats", async () => {
    return { sessions: await reads.chatSessions() };
  });

  app.get("/api/chats/:sessionId", async (req, reply): Promise<ChatLog | unknown> => {
    const { sessionId } = req.params as { sessionId: string };
    const result = await reads.chatLogBySessionId(sessionId);
    if (result.kind === "missing-root") {
      return reply.status(404).send({ error: "Not found" });
    }
    return result.chatLog;
  });
}
