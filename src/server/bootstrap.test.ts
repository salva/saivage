/**
 * Saivage — Bootstrap dispatch smoke tests (F03 B05).
 *
 * Verifies that the `createChildSpawner` librarian branch mutates the
 * shared `ragService.adminRoles` set before constructing the
 * `LibrarianAgent`, and that the roster's dispatch surface keeps chat
 * out of the librarian dispatch authority.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createChildSpawner, type SaivageRuntime } from "./bootstrap.js";
import { RuntimeTracker } from "../runtime/recovery.js";
import { NoteManager } from "../runtime/notes.js";
import { ensureDir } from "../store/documents.js";
import { getDispatchToolsFor } from "../agents/roster.js";
import type { AgentContext } from "../agents/types.js";
import type { ChatResponse } from "../providers/types.js";
import type { RagService } from "./rag/service.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "saivage-bootstrap-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeRuntime(opts: {
  ragService: RagService;
}): { runtime: SaivageRuntime; parentCtx: AgentContext } {
  const saivageDir = join(tmpDir, ".saivage");
  ensureDir(saivageDir);
  ensureDir(join(saivageDir, "skills"));
  ensureDir(join(saivageDir, "tmp", "state"));

  const router = {
    getMaxContextTokens: () => 200_000,
    countTokens: () => 0,
    chat: async (): Promise<ChatResponse> => ({
      content: "librarian done",
      toolCalls: [],
      finishReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };

  const mcpRuntime = {
    getAllTools: () => [],
    callTool: async () => ({ ok: true }),
  };

  const project: AgentContext["project"] = {
    projectRoot: tmpDir,
    saivageDir,
    config: {
      project_name: "test",
      objectives: ["test"],
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
      research: join(tmpDir, "research"),
      tmp: join(saivageDir, "tmp"),
      runtimeState: join(saivageDir, "tmp", "state", "runtime.json"),
      chats: join(saivageDir, "tmp", "chats"),
      inspectorWorkspace: join(saivageDir, "tmp", "inspector-workspace"),
      work: join(saivageDir, "tmp", "work"),
    },
  } as AgentContext["project"];

  const noteManager = new NoteManager(join(saivageDir, "notes"));
  const tracker = new RuntimeTracker(project.paths.runtimeState);
  const agentRegistry = new Map<string, import("../agents/base.js").BaseAgent>();

  const routing = {
    resolve: (_role: string) => ({
      modelSpec: "test/model",
      authProfile: undefined,
      accountRef: undefined,
    }),
  } as unknown as SaivageRuntime["routing"];

  const eventBus = {
    publish: async () => {},
  } as unknown as SaivageRuntime["eventBus"];

  const runtime: SaivageRuntime = {
    config: {} as SaivageRuntime["config"],
    router: router as unknown as SaivageRuntime["router"],
    routing,
    mcpRuntime: mcpRuntime as unknown as SaivageRuntime["mcpRuntime"],
    eventBus,
    planService: {} as SaivageRuntime["planService"],
    noteManager,
    project,
    tracker,
    plannerControl: {} as SaivageRuntime["plannerControl"],
    plannerStartupDirectives: [],
    agentRegistry,
    supervisor: null,
    ragService: opts.ragService,
    knowledgeStore: {} as SaivageRuntime["knowledgeStore"],
    shutdown: async () => {},
  };

  const parentCtx: AgentContext = {
    project,
    router: router as unknown as AgentContext["router"],
    mcpRuntime: mcpRuntime as unknown as AgentContext["mcpRuntime"],
    noteManager,
    agentId: "parent-1",
    role: "planner",
    modelSpec: "test/model",
  };

  return { runtime, parentCtx };
}

function makeRagService(): RagService {
  return {
    manager: {} as RagService["manager"],
    datasets: [],
    watchStatus: new Map(),
    adminRoles: new Set(),
    control: { busy: false },
    enabled: true,
    projectRoot: tmpDir,
  };
}

describe("createChildSpawner — librarian branch", () => {
  it("planner dispatch of run_librarian adds librarian to ragService.adminRoles", async () => {
    const ragService = makeRagService();
    const { runtime, parentCtx } = makeRuntime({ ragService });
    const spawner = createChildSpawner(runtime);

    expect(ragService.adminRoles.has("librarian")).toBe(false);

    const result = await spawner(
      "librarian",
      { objective: "audit rag policy" },
      { ...parentCtx, role: "planner" },
    );

    expect(ragService.adminRoles.has("librarian")).toBe(true);
    expect(result.kind).toBe("success");
  });

  it("manager dispatch of run_librarian adds librarian to ragService.adminRoles", async () => {
    const ragService = makeRagService();
    const { runtime, parentCtx } = makeRuntime({ ragService });
    const spawner = createChildSpawner(runtime);

    expect(ragService.adminRoles.has("librarian")).toBe(false);

    const result = await spawner(
      "librarian",
      { objective: "investigate retrieval miss", collection_id: "ds-1" },
      { ...parentCtx, role: "manager" },
    );

    expect(ragService.adminRoles.has("librarian")).toBe(true);
    expect(result.kind).toBe("success");
  });

  it("chat is not authorized to dispatch run_librarian (roster gate)", () => {
    // Enforcement happens at tool-exposure: chat's dispatch tool surface
    // is empty per ROSTER.dispatchableBy, so the LLM never sees
    // `run_librarian` as a callable tool.
    expect(getDispatchToolsFor("chat")).not.toContain("run_librarian");
    expect(getDispatchToolsFor("planner")).toContain("run_librarian");
    expect(getDispatchToolsFor("manager")).toContain("run_librarian");
  });
});
