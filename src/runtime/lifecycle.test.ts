import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventBus } from "../events/bus.js";
import type { KnowledgeStore } from "../knowledge/init.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { RagManager } from "../rag/index.js";
import type { ProjectContext } from "../store/project.js";
import { RuntimeLifecycle } from "./lifecycle.js";
import { createRuntimeState, type RuntimeLock, type RuntimeTracker } from "./recovery.js";
import type { RuntimeSupervisor } from "./supervisor.js";

describe("RuntimeLifecycle", () => {
  it("runs shutdown once and writes idle runtime state", async () => {
    const root = mkdtempSync(join(tmpdir(), "saivage-lifecycle-"));
    try {
      const project = makeProject(root);
      mkdirSync(join(project.saivageDir, "tmp", "state"), { recursive: true });
      writeFileSync(project.paths.runtimeState, JSON.stringify(createRuntimeState()), "utf-8");

      const tracker = { freeze: vi.fn() } as unknown as RuntimeTracker;
      const supervisor = { stop: vi.fn() } as unknown as RuntimeSupervisor;
      const mcpRuntime = { shutdown: vi.fn().mockResolvedValue(undefined) } as unknown as McpRuntime;
      const knowledgeStore = { sidecar: { close: vi.fn() } } as unknown as KnowledgeStore;
      const ragManager = { close: vi.fn().mockResolvedValue(undefined) } as unknown as RagManager;
      const eventBus = { clear: vi.fn() } as unknown as EventBus;
      const runtimeLock = { release: vi.fn() } as unknown as RuntimeLock;
      const lifecycle = new RuntimeLifecycle({
        project,
        tracker,
        mcpRuntime,
        knowledgeStore,
        ragManager,
        eventBus,
        runtimeLock,
        getSupervisor: () => supervisor,
      });

      await lifecycle.shutdown();
      await lifecycle.shutdown();

      expect(tracker.freeze).toHaveBeenCalledOnce();
      expect(supervisor.stop).toHaveBeenCalledOnce();
      expect(mcpRuntime.shutdown).toHaveBeenCalledOnce();
      expect(knowledgeStore.sidecar.close).toHaveBeenCalledOnce();
      expect(ragManager.close).toHaveBeenCalledOnce();
      expect(eventBus.clear).toHaveBeenCalledOnce();
      expect(runtimeLock.release).toHaveBeenCalledOnce();
      expect(JSON.parse(readFileSync(project.paths.runtimeState, "utf-8")).status).toBe("idle");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function makeProject(root: string): ProjectContext {
  const saivageDir = join(root, ".saivage");
  return {
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
      shutdownRequest: join(saivageDir, "tmp", "state", "shutdown-request.json"),
      shutdownSummary: join(saivageDir, "tmp", "state", "shutdown-summary.json"),
      chats: join(saivageDir, "tmp", "chats"),
      inspectorWorkspace: join(saivageDir, "tmp", "inspector-workspace"),
      work: join(saivageDir, "tmp", "work"),
    },
  };
}
