import type { FastifyInstance } from "fastify";
import type { BaseAgent } from "../../agents/base.js";

export interface AgentConversationReads {
  getAgent(agentId: string): BaseAgent | undefined;
}

export function registerAgentConversationRoutes(
  app: FastifyInstance,
  reads: AgentConversationReads,
): void {
  app.get("/api/agents/:agentId/conversation", async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const agent = reads.getAgent(agentId);
    if (!agent) {
      return reply.status(404).send({ error: "Agent not found or no longer running" });
    }
    return {
      agent_id: agentId,
      role: agent.role,
      started_at: agent.startedAt,
      message_count: agent.messageCount,
      entries: agent.getConversationSnapshot(),
      activity_status: agent.getActivityStatus(),
    };
  });
}
