import type { ToolSchema } from "../providers/types.js";
import { ROSTER, type AgentRole } from "./roster.js";

export const TRIVIAL_EVIDENCE_TOOLS = new Set(["list_dir", "read_stash"]);

export const RUN_MANAGER_SCHEMA: ToolSchema = {
  name: "run_manager",
  description:
    "Dispatch a stage to the Manager agent. The Manager decomposes it into tasks and runs worker agents. Returns a StageSummary on success.",
  inputSchema: {
    type: "object",
    properties: {
      stage: {
        type: "object",
        description: "The stage to execute",
        properties: {
          id: { type: "string", description: "Unique stage ID" },
          objective: { type: "string", description: "What this stage must achieve" },
          starting_points: { type: "array", items: { type: "string" }, description: "Files or areas to start from" },
          expected_outcomes: { type: "array", items: { type: "string" }, description: "What should exist when done" },
          acceptance_criteria: { type: "array", items: { type: "string" }, description: "Verifiable criteria for completion" },
          references: { type: "array", items: { type: "string" }, description: "Relevant files, docs, or URLs" },
          tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
        },
        required: ["id", "objective", "starting_points", "expected_outcomes", "acceptance_criteria", "references", "tags"],
      },
    },
    required: ["stage"],
  },
};

export const RUN_INSPECTOR_SCHEMA: ToolSchema = {
  name: "run_inspector",
  description:
    "Request deep analysis from the Inspector agent. Returns an InspectionReport with findings and recommendations.",
  inputSchema: {
    type: "object",
    properties: {
      request: {
        type: "object",
        description: "The inspection request",
        properties: {
          id: { type: "string", description: "Unique inspection ID" },
          scope: { type: "string", description: "What area to inspect" },
          questions: { type: "array", items: { type: "string" }, description: "Specific questions to answer" },
          requested_at: { type: "string", description: "ISO timestamp" },
          requested_by: { type: "string", enum: ["planner", "chat"], description: "Who requested this" },
        },
        required: ["id", "scope", "questions", "requested_at", "requested_by"],
      },
    },
    required: ["request"],
  },
};

export const RUN_CODER_SCHEMA: ToolSchema = makeWorkerDispatchSchema(
  "run_coder",
  "Dispatch a coding task to a Coder worker agent. Returns a TaskReport.",
  "The task to execute",
);

export const RUN_RESEARCHER_SCHEMA: ToolSchema = makeWorkerDispatchSchema(
  "run_researcher",
  "Dispatch a research task to a Researcher worker agent. Returns a TaskReport.",
  "The research task",
);

export const RUN_DATA_AGENT_SCHEMA: ToolSchema = makeWorkerDispatchSchema(
  "run_data_agent",
  "Dispatch a data acquisition task to a Data Agent. Use for finding, downloading, validating, and documenting external datasets or API data. Returns a TaskReport.",
  "The data acquisition task",
);

export const RUN_REVIEWER_SCHEMA: ToolSchema = makeWorkerDispatchSchema(
  "run_reviewer",
  "Dispatch a review task to a Reviewer worker agent after stage work is done. Use to validate stage objectives, acceptance criteria, work products, data/statistical quality, and issues before writing StageSummary. Returns a TaskReport.",
  "The review task",
);

export const RUN_DESIGNER_SCHEMA: ToolSchema = makeWorkerDispatchSchema(
  "run_designer",
  "Dispatch a design task to a Designer worker agent. Use for product, UX, interface, information-architecture, or system-design work that should be settled before coding starts. Returns a TaskReport.",
  "The design task",
);

export const RUN_CRITIC_SCHEMA: ToolSchema = makeWorkerDispatchSchema(
  "run_critic",
  "Dispatch a design-critique task to a Critic worker agent. Use after the Designer produces specs, briefs, architecture docs, or other design artifacts: the Critic reviews them, writes a standalone critique document, and returns a TaskReport with actionable issues. Does not review code, tests, or data.",
  "The design critique task",
);

export const RUN_LIBRARIAN_SCHEMA: ToolSchema = {
  name: "run_librarian",
  description:
    "Dispatch a one-shot Librarian agent to investigate or curate the RAG knowledge surface. Returns a markdown report (not a TaskReport). The Librarian may register, ingest, query, or drop unprotected collections and record memories under topic.domain='rag', but does not edit source files, write skills, or mutate plan state.",
  inputSchema: {
    type: "object",
    properties: {
      objective: {
        type: "string",
        description: "What the Librarian should investigate or curate.",
      },
      collection_id: {
        type: "string",
        description: "Optional collection the operator wants the Librarian to focus on.",
      },
      context: {
        type: "string",
        description: "Optional additional context, links, or constraints.",
      },
    },
    required: ["objective"],
  },
};

export function makeWorkerDispatchSchema(
  name: string,
  description: string,
  taskDescription: string,
): ToolSchema {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "object",
          description: taskDescription,
          properties: {
            id: { type: "string" },
            objective: { type: "string" },
            files: { type: "array", items: { type: "string" } },
            instructions: { type: "string" },
            acceptance_criteria: { type: "array", items: { type: "string" } },
          },
          required: ["id", "objective", "files", "instructions", "acceptance_criteria"],
        },
        stageId: { type: "string", description: "Parent stage ID" },
      },
      required: ["task", "stageId"],
    },
  };
}

const DISPATCH_SCHEMA_BY_TOOL: Record<string, ToolSchema> = {
  run_manager: RUN_MANAGER_SCHEMA,
  run_inspector: RUN_INSPECTOR_SCHEMA,
  run_coder: RUN_CODER_SCHEMA,
  run_researcher: RUN_RESEARCHER_SCHEMA,
  run_data_agent: RUN_DATA_AGENT_SCHEMA,
  run_reviewer: RUN_REVIEWER_SCHEMA,
  run_designer: RUN_DESIGNER_SCHEMA,
  run_critic: RUN_CRITIC_SCHEMA,
  run_librarian: RUN_LIBRARIAN_SCHEMA,
};

export const ROLE_DISPATCH_TOOLS: Partial<Record<AgentRole, ToolSchema[]>> = (() => {
  const map: Partial<Record<AgentRole, ToolSchema[]>> = {};
  for (const entry of ROSTER) {
    if (!entry.dispatchTool) continue;
    const schema = DISPATCH_SCHEMA_BY_TOOL[entry.dispatchTool];
    if (!schema) {
      throw new Error(`Missing dispatch schema for tool ${entry.dispatchTool}`);
    }
    for (const parent of entry.dispatchableBy) {
      const key = parent as AgentRole;
      (map[key] ??= []).push(schema);
    }
  }
  return map;
})();

export function getDispatchToolsForRole(role: AgentRole): ToolSchema[] {
  return ROLE_DISPATCH_TOOLS[role] ?? [];
}
