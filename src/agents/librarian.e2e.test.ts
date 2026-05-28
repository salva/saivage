/**
 * Saivage — LibrarianAgent end-to-end test (F03 B07).
 *
 * Exercises the full dispatch path through `createChildSpawner` with a
 * real `KnowledgeStore` and a real `McpRuntime`, using a stub `rag`
 * in-process service alongside the real `memory` handler. Canned LLM
 * responses drive the librarian through a realistic tool sequence:
 * `rag_list` → `rag_stats` → `search_memories` → `create_memory`.
 *
 * Covers:
 *   - Planner dispatches `run_librarian`; librarian exits success.
 *   - `ragService.adminRoles` gains `"librarian"` (admin-role wiring).
 *   - The librarian writes a `rag/policy` project memory that is
 *     subsequently queryable via `listMemories`.
 *   - Manager dispatching a `"rag retrieval miss:"` objective also
 *     routes through the same librarian path.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProjectTree } from "../store/project.js";
import { acquireRuntimeLock, type RuntimeLock, RuntimeTracker } from "../runtime/recovery.js";
import { NoteManager } from "../runtime/notes.js";
import { ensureDir } from "../store/documents.js";
import { McpRuntime } from "../mcp/runtime.js";
import {
  knowledgeMemoryTools,
  makeKnowledgeMemoryHandler,
} from "../mcp/knowledgeMemory.js";
import { makeTestStore } from "../knowledge/_testfixtures/store.js";
import { listMemories } from "../knowledge/lifecycle.js";
import { createChildSpawner, type SaivageRuntime } from "../server/bootstrap.js";
import type { ToolEntry } from "../mcp/types.js";
import type { InProcessToolHandler } from "../mcp/runtime.js";
import type { SaivageConfig } from "../config.js";
import type { AgentContext } from "../agents/types.js";
import type { ChatRequest, ChatResponse, ToolCallResult } from "../providers/types.js";
import type { RagService } from "../server/rag/service.js";
import type { KnowledgeStore } from "../knowledge/init.js";

interface ScriptStep {
  content?: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
  end?: boolean;
}

function makeScriptedRouter(script: ScriptStep[]): AgentContext["router"] {
  let i = 0;
  return {
    getMaxContextTokens: () => 200_000,
    countTokens: () => 0,
    chat: async (_req: ChatRequest): Promise<ChatResponse> => {
      if (i >= script.length) {
        throw new Error(
          `scripted router exhausted after ${i} calls — agent kept looping`,
        );
      }
      const step = script[i++];
      const toolCalls: ToolCallResult[] = (step.toolCalls ?? []).map(
        (tc, idx) => ({ id: `t${i}-${idx}`, name: tc.name, input: tc.input }),
      );
      const finishReason = step.end
        ? "end_turn"
        : toolCalls.length > 0
          ? "tool_use"
          : "end_turn";
      return {
        content: step.content ?? "",
        toolCalls,
        finishReason,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  } as unknown as AgentContext["router"];
}

function testConfig(): SaivageConfig {
  return {
    runtime: { maxServices: 50, restartOnCrash: false, healthCheckIntervalMs: 0, idleShutdownMs: 0 },
    mcp: {
      shellTimeoutMs: 60_000,
      shellTimeoutFloorMs: 10_000,
      inProcessTimeoutMs: 30_000,
      maxOutputBytes: 100_000,
      maxFetchChars: 100_000,
      maxDownloadBytes: 1_000_000,
      maxFileReadBytes: 100_000,
    },
  } as unknown as SaivageConfig;
}

const RAG_TOOLS: ToolEntry[] = [
  { name: "rag_list", description: "List datasets.", inputSchema: { type: "object" } },
  { name: "rag_stats", description: "Dataset stats.", inputSchema: { type: "object" } },
  { name: "rag_query", description: "Query a dataset.", inputSchema: { type: "object" } },
];

function makeRagStub(): { handler: InProcessToolHandler; calls: string[] } {
  const calls: string[] = [];
  const handler: InProcessToolHandler = async (toolName, _args) => {
    calls.push(toolName);
    switch (toolName) {
      case "rag_list":
        return {
          content: { datasets: [{ id: "ds-1", name: "ds-1", kind: "files" }] },
          isError: false,
        };
      case "rag_stats":
        return {
          content: { chunks: 1200, chunksDroppedSecrets: 0, lastIngestAt: "2025-05-01T00:00:00Z" },
          isError: false,
        };
      case "rag_query":
        return { content: { hits: [] }, isError: false };
      default:
        return { content: { ok: true }, isError: false };
    }
  };
  return { handler, calls };
}

function makeRagService(projectRoot: string): RagService {
  return {
    manager: {} as RagService["manager"],
    datasets: [],
    watchStatus: new Map(),
    adminRoles: new Set(),
    control: { busy: false },
    enabled: true,
    projectRoot,
  };
}

let tmpDir: string;
let runtimeLock: RuntimeLock | null = null;
let store: KnowledgeStore | null = null;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "librarian-e2e-"));
  await initProjectTree(tmpDir);
  runtimeLock = await acquireRuntimeLock(join(tmpDir, ".saivage"));
});

afterEach(() => {
  store?.sidecar.close();
  store = null;
  runtimeLock?.release();
  runtimeLock = null;
  rmSync(tmpDir, { recursive: true, force: true });
});

interface E2ESetup {
  runtime: SaivageRuntime;
  parentCtx: AgentContext;
  ragService: RagService;
  store: KnowledgeStore;
  ragCalls: string[];
}

async function setupRuntime(script: ScriptStep[]): Promise<E2ESetup> {
  const saivageDir = join(tmpDir, ".saivage");
  ensureDir(saivageDir);
  ensureDir(join(saivageDir, "skills"));
  ensureDir(join(saivageDir, "tmp", "state"));

  const ks = await makeTestStore(tmpDir);
  store = ks;

  const mcpRuntime = new McpRuntime(testConfig());
  mcpRuntime.registerInProcess("memory", knowledgeMemoryTools, makeKnowledgeMemoryHandler(ks));
  const { handler: ragHandler, calls: ragCalls } = makeRagStub();
  mcpRuntime.registerInProcess("rag", RAG_TOOLS, ragHandler);

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

  const router = makeScriptedRouter(script);
  const noteManager = new NoteManager(join(saivageDir, "notes"));
  const tracker = new RuntimeTracker(project.paths.runtimeState);
  const agentRegistry = new Map<string, import("../agents/base.js").BaseAgent>();
  const ragService = makeRagService(tmpDir);

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
    ragService,
    knowledgeStore: ks as unknown as SaivageRuntime["knowledgeStore"],
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

  return { runtime, parentCtx, ragService, store: ks, ragCalls };
}

describe("LibrarianAgent — end-to-end via createChildSpawner (F03 B07)", () => {
  it("planner → run_librarian: rag_list + rag_stats + search_memories + create_memory, writes a queryable rag/policy memory", async () => {
    const script: ScriptStep[] = [
      {
        content: "Inventorying RAG datasets.",
        toolCalls: [
          { name: "rag_list", input: {} },
          { name: "rag_stats", input: { dataset_id: "ds-1" } },
          { name: "search_memories", input: { query: "rag policy ds-1", limit: 5 } },
        ],
      },
      {
        content: "No prior policy memory; recording one.",
        toolCalls: [
          {
            name: "create_memory",
            input: {
              topic: { domain: "rag", subject: "policy", aspect: "ds-1" },
              keys: ["ds-1", "policy"],
              scope: "project",
              body: JSON.stringify({
                collection_id: "ds-1",
                policy: "re-ingest weekly; refuse non-rag topics",
              }),
              reason: "Initial RAG policy for ds-1",
            },
          },
        ],
      },
      { content: "Librarian completed audit for ds-1.", end: true },
    ];

    const { runtime, parentCtx, ragService, store: ks, ragCalls } =
      await setupRuntime(script);
    const spawner = createChildSpawner(runtime);

    expect(ragService.adminRoles.has("librarian")).toBe(false);

    const result = await spawner(
      "librarian",
      { objective: "Audit RAG policy state", collection_id: "ds-1" },
      { ...parentCtx, role: "planner" },
    );

    expect(result.kind).toBe("success");
    // F02 admin-roles wiring.
    expect(ragService.adminRoles.has("librarian")).toBe(true);
    // RAG stub saw the expected tool calls.
    expect(ragCalls).toContain("rag_list");
    expect(ragCalls).toContain("rag_stats");
    // Memory was actually written to the real store and is queryable.
    const memories = await listMemories(ks, { topic_domain: "rag" });
    expect(memories).toHaveLength(1);
    const m = memories[0];
    expect(m.topic.domain).toBe("rag");
    expect(m.topic.subject).toBe("policy");
    expect(m.scope).toBe("project");
  });

  it("manager → run_librarian for a 'rag retrieval miss:' objective dispatches successfully via the same path", async () => {
    const script: ScriptStep[] = [
      {
        content: "Querying ds-2 to confirm the miss.",
        toolCalls: [
          {
            name: "rag_query",
            input: { dataset_id: "ds-2", query: "tokenizer config", limit: 10 },
          },
        ],
      },
      {
        content: "Recording miss as a fallback policy memory.",
        toolCalls: [
          {
            name: "create_memory",
            input: {
              topic: { domain: "rag", subject: "policy", aspect: "ds-2" },
              keys: ["ds-2", "retrieval-miss"],
              scope: "project",
              body: JSON.stringify({
                collection_id: "ds-2",
                miss: "tokenizer config",
                recommendation: "ingest tokenizer documentation",
              }),
              reason: "Document retrieval miss for ds-2",
            },
          },
        ],
      },
      { content: "Done; miss recorded.", end: true },
    ];

    const { runtime, parentCtx, ragService, store: ks } = await setupRuntime(script);
    const spawner = createChildSpawner(runtime);

    const result = await spawner(
      "librarian",
      {
        objective: "Investigate RAG retrieval miss for ds-2",
        collection_id: "ds-2",
        context: "rag retrieval miss: ds-2 — worker reported zero hits for 'tokenizer config'",
      },
      { ...parentCtx, role: "manager" },
    );

    expect(result.kind).toBe("success");
    expect(ragService.adminRoles.has("librarian")).toBe(true);
    const memories = await listMemories(ks, { topic_domain: "rag" });
    expect(memories).toHaveLength(1);
    expect(memories[0].topic.subject).toBe("policy");
    expect(memories[0].topic.aspect).toBe("ds-2");
  });
});
