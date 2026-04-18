/**
 * Orchestrator MCP Service — in-process tools that let agents
 * interact with the running orchestrator directly.
 *
 * Registered on the McpRuntime as an in-process service (no subprocess).
 */

import type { ToolEntry } from "../mcp/registry.js";
import type { InProcessToolHandler } from "../mcp/runtime.js";
import type { Orchestrator } from "./orchestrator.js";
import type { Priority } from "./state.js";
import { log } from "../log.js";

/** Tool schemas exposed to agents */
export const orchestratorTools: ToolEntry[] = [
  {
    name: "orch_get_state",
    description:
      "Get a summary of the orchestrator state: counts of todos by status, active agents, and planning status",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "orch_get_todos",
    description:
      "Get the TODO list, optionally filtered by status. Returns id, goal, status, priority, agentType, and result/error.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "in-progress", "blocked", "completed", "failed", "cancelled"],
          description: "Filter by status (optional)",
        },
        limit: {
          type: "number",
          description: "Max results (default: 20)",
        },
      },
    },
  },
  {
    name: "orch_get_agents",
    description: "Get information about currently active (running) agents",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "orch_submit_work",
    description:
      "Submit a new work request to the orchestrator. The orchestrator will dispatch an agent to work on it.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What needs to be done" },
        priority: {
          type: "number",
          description: "0=interactive, 1=foreground, 2=system, 3=background (default: 1)",
        },
        agentType: {
          type: "string",
          description: "Agent type: coder, researcher, executor (default: coder)",
        },
        project: {
          type: "string",
          enum: ["target", "self"],
          description: "Which project (default: target)",
        },
        context: { type: "string", description: "Additional context for the agent" },
      },
      required: ["goal"],
    },
  },
  {
    name: "orch_cancel_work",
    description: "Cancel a pending or running work item by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "TODO item ID to cancel" },
      },
      required: ["id"],
    },
  },
  {
    name: "orch_replan",
    description:
      "Request a full replan: the orchestrator LLM reviews the current queue against new requirements and decides what to cancel, keep, and create.",
    inputSchema: {
      type: "object",
      properties: {
        requirements: {
          type: "string",
          description: "New direction, priorities, or changes",
        },
      },
      required: ["requirements"],
    },
  },
  {
    name: "orch_message_agent",
    description:
      "Send an out-of-band message to a running agent. The message is injected into its conversation at the next iteration, allowing runtime redirection without cancellation.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent ID (or first 8 chars)" },
        message: { type: "string", description: "Message to inject into the agent's conversation" },
      },
      required: ["agentId", "message"],
    },
  },
  {
    name: "orch_modify_work",
    description:
      "Modify a pending work item's goal, priority, or agent type.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "TODO item ID to modify" },
        goal: { type: "string", description: "New goal (optional)" },
        priority: { type: "number", description: "New priority 0-3 (optional)" },
        agentType: { type: "string", description: "New agent type (optional)" },
        context: { type: "string", description: "New context (optional)" },
      },
      required: ["id"],
    },
  },
  {
    name: "orch_get_plan",
    description:
      "Get the master plan summary: vision, objectives, and all stages with their statuses. Shows the big-picture project roadmap.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "orch_get_stage",
    description:
      "Get the current active stage plan: goal, approach, and all tasks with their live statuses.",
    inputSchema: { type: "object", properties: {} },
  },
];

/**
 * Create the tool handler function that dispatches orch_* calls
 * to the running Orchestrator instance.
 */
export function createOrchestratorToolHandler(
  orchestrator: Orchestrator,
): InProcessToolHandler {
  return async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: unknown; isError: boolean }> => {
    try {
      switch (toolName) {
        case "orch_get_state": {
          const state = orchestrator.getState();
          const summary = {
            totalTodos: state.todos.length,
            pending: state.todos.filter((t) => t.status === "pending").length,
            inProgress: state.todos.filter((t) => t.status === "in-progress").length,
            completed: state.todos.filter((t) => t.status === "completed").length,
            failed: state.todos.filter((t) => t.status === "failed").length,
            blocked: state.todos.filter((t) => t.status === "blocked").length,
            activeAgents: state.activeAgents.length,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(summary) }],
            isError: false,
          };
        }

        case "orch_get_todos": {
          const state = orchestrator.getState();
          let todos = state.todos;
          if (typeof args.status === "string") {
            todos = todos.filter((t) => t.status === args.status);
          }
          const limit = typeof args.limit === "number" ? args.limit : 20;
          const items = todos.slice(-limit).map((t) => ({
            id: t.id,
            goal: t.goal,
            status: t.status,
            priority: t.priority,
            agentType: t.agentType,
            result: t.result?.slice(0, 300),
            error: t.error?.slice(0, 300),
            createdAt: t.createdAt,
          }));
          return {
            content: [{ type: "text", text: JSON.stringify(items) }],
            isError: false,
          };
        }

        case "orch_get_agents": {
          const state = orchestrator.getState();
          return {
            content: [
              { type: "text", text: JSON.stringify(state.activeAgents) },
            ],
            isError: false,
          };
        }

        case "orch_submit_work": {
          const goal = args.goal as string;
          if (!goal) {
            return {
              content: [{ type: "text", text: "Error: 'goal' is required" }],
              isError: true,
            };
          }
          const todoId = orchestrator.submitWork({
            goal,
            priority: (typeof args.priority === "number"
              ? args.priority
              : 1) as Priority,
            agentType:
              typeof args.agentType === "string" ? args.agentType : "coder",
            project:
              args.project === "self" ? "self" : "target",
            context:
              typeof args.context === "string" ? args.context : undefined,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ submitted: true, id: todoId, goal }),
              },
            ],
            isError: false,
          };
        }

        case "orch_cancel_work": {
          const id = args.id as string;
          if (!id) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required" }],
              isError: true,
            };
          }
          const cancelled = orchestrator.cancelWork(id);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  cancelled,
                  id,
                  ...(cancelled ? {} : { error: "Task not found or not cancellable" }),
                }),
              },
            ],
            isError: !cancelled,
          };
        }

        case "orch_replan": {
          const requirements = args.requirements as string;
          if (!requirements) {
            return {
              content: [
                { type: "text", text: "Error: 'requirements' is required" },
              ],
              isError: true,
            };
          }
          // Fire replan asynchronously — it's an LLM call that takes time
          orchestrator.replan(requirements).catch((err) => {
            log.error(`Replan via MCP failed: ${err}`);
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  accepted: true,
                  message:
                    "Replan initiated. The orchestrator will review the queue and adjust.",
                }),
              },
            ],
            isError: false,
          };
        }

        case "orch_message_agent": {
          const agentId = args.agentId as string;
          const message = args.message as string;
          if (!agentId || !message) {
            return {
              content: [{ type: "text", text: "Error: 'agentId' and 'message' are required" }],
              isError: true,
            };
          }
          // Support short IDs — find matching agent
          const state = orchestrator.getState();
          const match = state.activeAgents.find(
            (a) => a.id === agentId || a.id.startsWith(agentId),
          );
          if (!match) {
            return {
              content: [{ type: "text", text: JSON.stringify({ sent: false, error: "Agent not found or not running" }) }],
              isError: true,
            };
          }
          const sent = orchestrator.messageAgent(match.id, message);
          return {
            content: [{ type: "text", text: JSON.stringify({ sent, agentId: match.id }) }],
            isError: !sent,
          };
        }

        case "orch_modify_work": {
          const id = args.id as string;
          if (!id) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required" }],
              isError: true,
            };
          }
          const changes: Record<string, unknown> = {};
          if (typeof args.goal === "string") changes.goal = args.goal;
          if (typeof args.priority === "number") changes.priority = args.priority;
          if (typeof args.agentType === "string") changes.agentType = args.agentType;
          if (typeof args.context === "string") changes.context = args.context;

          const modified = orchestrator.modifyWork(id, changes as any);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  modified,
                  id,
                  ...(modified ? {} : { error: "Task not found or not pending" }),
                }),
              },
            ],
            isError: !modified,
          };
        }

        case "orch_get_plan": {
          const summary = orchestrator.getPlanSummary();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  summary ?? { error: "No master plan available" },
                ),
              },
            ],
            isError: !summary,
          };
        }

        case "orch_get_stage": {
          const summary = orchestrator.getStageSummary();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  summary ?? { error: "No active stage" },
                ),
              },
            ],
            isError: !summary,
          };
        }

        default:
          return {
            content: [
              { type: "text", text: `Unknown tool: ${toolName}` },
            ],
            isError: true,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  };
}
