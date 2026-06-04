import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";

import { buildManagerMessage } from "./manager.js";
import { NoteManager } from "../runtime/notes.js";
import type { AgentContext, ManagerInput } from "./types.js";

vi.mock("./handoff.js", () => ({
  buildHandoffContext: vi.fn().mockResolvedValue("## Shared Project Context\n[FIXTURE HANDOFF]"),
}));

describe("buildManagerMessage", () => {
  it("instructs managers to submit stage artifacts through MCP tools", async () => {
    const message = await buildManagerMessage(makeContext(), makeInput());

    expect(message).toContain("stage_write_tasks({ task_list })");
    expect(message).toContain(".saivage/stages/stage-1/tasks.json");
    expect(message).toContain("stage_write_summary({ summary })");
    expect(message).toContain(".saivage/stages/stage-1/summary.json");
    expect(message).toContain("Do not include the full StageSummary JSON in the final response");
    expect(message).toMatchSnapshot();
  });
});

function makeContext(): AgentContext {
  const root = "/fixture/project";
  const saivageDir = join(root, ".saivage");
  return {
    project: {
      projectRoot: root,
      saivageDir,
      config: {
        project_name: "test",
        objectives: ["test objective"],
        provider: "test",
        notifications: { channels: [], filters: { min_severity: "info", categories: [] } },
        skills: { max_per_agent: 5 },
      },
      paths: {
        plan: join(saivageDir, "plan.json"),
        stages: join(saivageDir, "stages"),
        notes: join(saivageDir, "notes"),
        inspections: join(saivageDir, "inspections"),
        skills: join(saivageDir, "skills"),
        tools: join(saivageDir, "tools"),
        research: join(root, "research"),
        tmp: join(saivageDir, "tmp"),
        runtimeState: join(saivageDir, "tmp", "state", "runtime.json"),
        chats: join(saivageDir, "tmp", "chats"),
        inspectorWorkspace: join(saivageDir, "tmp", "inspector-workspace"),
        work: join(saivageDir, "tmp", "work"),
      },
    },
    router: {
      getMaxContextTokens: () => 200_000,
      countTokens: () => 0,
      chat: async () => {
        throw new Error("not used");
      },
      resetModelHealth: () => {},
    } as AgentContext["router"],
    mcpRuntime: {
      getAllTools: () => [],
      callTool: async () => ({ ok: true }),
    } as AgentContext["mcpRuntime"],
    noteManager: new NoteManager(join(saivageDir, "notes")),
    agentId: "manager-1",
    role: "manager",
    stageId: "stage-1",
    modelSpec: "test/model",
  };
}

function makeInput(): ManagerInput {
  return {
    stage: {
      id: "stage-1",
      objective: "Implement the fixture stage",
      starting_points: ["README.md"],
      expected_outcomes: ["Outcome A"],
      acceptance_criteria: ["Criterion A"],
      references: ["docs/spec.md"],
      tags: ["fixture"],
    },
  };
}
