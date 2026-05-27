import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildInitialMessage } from "./worker.js";
import type { AgentContext, WorkerInput } from "./types.js";
import type { WorkerRole } from "./roster.js";
import type { Task } from "../types.js";
import { NoteManager } from "../runtime/notes.js";

vi.mock("./handoff.js", () => ({
  buildHandoffContext: vi.fn().mockResolvedValue("## Shared Project Context\n[FIXTURE HANDOFF]"),
}));

describe("buildInitialMessage", () => {
  it("renders coder assignment", async () => {
    const { root, cleanup } = makeProjectRoot();
    try {
      expect(await buildInitialMessage(makeContext(root), makeInput("coder"), "coder")).toMatchSnapshot();
    } finally {
      cleanup();
    }
  });

  it("renders researcher assignment", async () => {
    const { root, cleanup } = makeProjectRoot();
    try {
      expect(
        await buildInitialMessage(makeContext(root), makeInput("researcher"), "researcher"),
      ).toMatchSnapshot();
    } finally {
      cleanup();
    }
  });

  it("renders data-agent assignment", async () => {
    const { root, cleanup } = makeProjectRoot();
    try {
      expect(
        await buildInitialMessage(makeContext(root), makeInput("data_agent"), "data_agent"),
      ).toMatchSnapshot();
    } finally {
      cleanup();
    }
  });

  it("renders designer assignment", async () => {
    const { root, cleanup } = makeProjectRoot();
    try {
      expect(
        await buildInitialMessage(makeContext(root), makeInput("designer"), "designer"),
      ).toMatchSnapshot();
    } finally {
      cleanup();
    }
  });

  it("renders critic assignment", async () => {
    const { root, cleanup } = makeProjectRoot();
    try {
      expect(
        await buildInitialMessage(makeContext(root), makeInput("critic"), "critic"),
      ).toMatchSnapshot();
    } finally {
      cleanup();
    }
  });

  it("renders reviewer assignment", async () => {
    const { root, cleanup } = makeProjectRoot();
    try {
      expect(
        await buildInitialMessage(makeContext(root), makeInput("reviewer"), "reviewer"),
      ).toMatchSnapshot();
    } finally {
      cleanup();
    }
  });

  it("renders reviewer follow-up assignment", async () => {
    const { root, cleanup } = makeProjectRoot();
    try {
      expect(
        await buildInitialMessage(makeContext(root), makeInput("reviewer"), "reviewer", {
          headingSuffix: " - Follow-up Review 2",
          prependFollowUp: true,
        }),
      ).toMatchSnapshot();
    } finally {
      cleanup();
    }
  });
});

function makeProjectRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "saivage-worker-message-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function makeContext(root: string): AgentContext {
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
    agentId: "agent-1",
    role: "coder",
    stageId: "stage-1",
    modelSpec: "test/model",
  };
}

function makeInput(role: WorkerRole): WorkerInput {
  const types: Record<WorkerRole, Task["type"]> = {
    coder: "code",
    researcher: "research",
    data_agent: "data",
    reviewer: "review",
    designer: "design",
    critic: "critique",
  };
  return {
    stageId: "stage-1",
    task: {
      id: `${role}-task`,
      type: types[role],
      assigned_to: role,
      description: `Complete the ${role} task`,
      checklist: [{ description: "first acceptance check", required: true }],
      dependencies: [],
      status: "pending",
      tags: ["fixture"],
      attempt: 2,
      max_attempts: 4,
    },
  };
}
