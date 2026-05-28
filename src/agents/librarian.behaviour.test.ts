/**
 * Saivage — LibrarianAgent behaviour suite (F03 B07).
 *
 * Drives `LibrarianAgent.run()` through canned LLM responses against a
 * stub `mcpRuntime` that records every tool call. Verifies the four
 * decision-tree scenarios from design §A.5 / analysis §§4-6:
 *
 *   1. drift confirmation gate — destructive `rag_drop` requires
 *      operator confirmation; `rag_stats` drift indicators alone do
 *      not authorise it.
 *   2. secret-incident memory payload — body is exactly
 *      `{count, collection_id, context}` (no `lastIngestAt`, no path
 *      lists, no chunk hashes).
 *   3. protected-dataset redirect — `knowledge.skills` /
 *      `knowledge.memory` queries go through `search_skills` /
 *      `search_memories`, never `rag_query`.
 *   4. no-hit fallback — empty `rag_query` triggers a `rag/policy`
 *      memory write documenting the miss.
 *
 * These tests don't render the prompt; they verify the runtime wiring
 * given the tool-call sequence a well-behaved librarian would emit.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LibrarianAgent, type LibrarianInput } from "./librarian.js";
import { ensureDir } from "../store/documents.js";
import { NoteManager } from "../runtime/notes.js";
import type { AgentContext } from "./types.js";
import type { ChatRequest, ChatResponse, ToolCallResult } from "../providers/types.js";
import type { RuntimeToolEntry } from "../mcp/runtime.js";

interface RecordedCall {
  service: string;
  name: string;
  args: Record<string, unknown>;
}

const LIBRARIAN_TOOL_CATALOG: RuntimeToolEntry[] = [
  { service: "rag", name: "rag_list", description: "", inputSchema: {} },
  { service: "rag", name: "rag_stats", description: "", inputSchema: {} },
  { service: "rag", name: "rag_query", description: "", inputSchema: {} },
  { service: "rag", name: "rag_register", description: "", inputSchema: {} },
  { service: "rag", name: "rag_ingest", description: "", inputSchema: {} },
  { service: "rag", name: "rag_drop", description: "", inputSchema: {} },
  { service: "rag", name: "rag_admin", description: "", inputSchema: {} },
  { service: "memory", name: "list_memories", description: "", inputSchema: {} },
  { service: "memory", name: "get_memory", description: "", inputSchema: {} },
  { service: "memory", name: "search_memories", description: "", inputSchema: {} },
  { service: "memory", name: "create_memory", description: "", inputSchema: {} },
  { service: "memory", name: "update_memory", description: "", inputSchema: {} },
  { service: "skills", name: "list_skills", description: "", inputSchema: {} },
  { service: "skills", name: "read_skill", description: "", inputSchema: {} },
  { service: "skills", name: "search_skills", description: "", inputSchema: {} },
  { service: "filesystem", name: "read_file", description: "", inputSchema: {} },
  { service: "filesystem", name: "list_dir", description: "", inputSchema: {} },
  { service: "filesystem", name: "search_files", description: "", inputSchema: {} },
];

type ToolStub = (args: Record<string, unknown>) => unknown;

function makeMcpStub(handlers: Record<string, ToolStub>): {
  mcp: AgentContext["mcpRuntime"];
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const mcp = {
    getAllTools: () => LIBRARIAN_TOOL_CATALOG,
    callTool: async (
      service: string,
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push({ service, name, args });
      const handler = handlers[name];
      if (!handler) return { ok: true };
      return handler(args);
    },
  } as unknown as AgentContext["mcpRuntime"];
  return { mcp, calls };
}

interface ScriptStep {
  content?: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
  end?: boolean;
}

function makeScriptedRouter(script: ScriptStep[]): {
  router: AgentContext["router"];
  callCount: () => number;
} {
  let i = 0;
  const router = {
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
  return { router, callCount: () => i };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "librarian-behaviour-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(
  router: AgentContext["router"],
  mcp: AgentContext["mcpRuntime"],
): AgentContext {
  const saivageDir = join(tmpDir, ".saivage");
  ensureDir(saivageDir);
  ensureDir(join(saivageDir, "skills"));
  return {
    project: {
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
    } as AgentContext["project"],
    router,
    mcpRuntime: mcp,
    noteManager: new NoteManager(join(saivageDir, "notes")),
    agentId: "librarian-1",
    role: "librarian",
    modelSpec: "test/model",
  };
}

async function runWith(
  input: LibrarianInput,
  script: ScriptStep[],
  handlers: Record<string, ToolStub>,
): Promise<{ result: Awaited<ReturnType<LibrarianAgent["run"]>>; calls: RecordedCall[] }> {
  const { mcp, calls } = makeMcpStub(handlers);
  const { router } = makeScriptedRouter(script);
  const ctx = makeCtx(router, mcp);
  const agent = await LibrarianAgent.create(ctx, input);
  const result = await agent.run();
  return { result, calls };
}

describe("LibrarianAgent — decision-tree behaviour (F03 B07)", () => {
  it("drift confirmation gate: drift via rag_stats does not trigger rag_drop without operator confirmation", async () => {
    const handlers: Record<string, ToolStub> = {
      rag_stats: () => ({
        chunksDroppedSecrets: 47,
        lastIngestAt: "2024-01-01T00:00:00Z",
        chunks: 1200,
      }),
      rag_list: () => ({
        datasets: [{ id: "ds-suspicious", name: "ds-suspicious" }],
      }),
    };
    const script: ScriptStep[] = [
      {
        content: "Inspecting RAG drift indicators.",
        toolCalls: [
          { name: "rag_list", input: {} },
          { name: "rag_stats", input: { dataset_id: "ds-suspicious" } },
        ],
      },
      {
        content:
          "Drift detected on ds-suspicious (47 secret drops, stale ingest). " +
          "Operator confirmation required before destructive recovery (rag_drop). " +
          "Awaiting confirmation.",
        end: true,
      },
    ];
    const { result, calls } = await runWith(
      { objective: "Investigate drift on ds-suspicious", collection_id: "ds-suspicious" },
      script,
      handlers,
    );
    expect(result.kind).toBe("success");
    const names = calls.map((c) => c.name);
    expect(names).toContain("rag_stats");
    expect(names).not.toContain("rag_drop");
    expect(names).not.toContain("rag_admin");
    if (result.kind === "success") {
      expect(result.data.toLowerCase()).toMatch(/confirm/);
    }
  });

  it("secret-incident memory payload: body contains exactly {count, collection_id, context}", async () => {
    const handlers: Record<string, ToolStub> = {
      rag_stats: () => ({ chunksDroppedSecrets: 3, chunks: 500 }),
      create_memory: () => ({ id: "mem-secret-1" }),
    };
    const script: ScriptStep[] = [
      {
        content: "Checking secret-redaction counters.",
        toolCalls: [{ name: "rag_stats", input: { dataset_id: "ds-1" } }],
      },
      {
        content: "Recording secret-incident memory.",
        toolCalls: [
          {
            name: "create_memory",
            input: {
              topic: { domain: "rag", subject: "secret-incidents", aspect: "ds-1" },
              keys: ["ds-1", "secrets"],
              scope: "project",
              body: JSON.stringify({
                count: 3,
                collection_id: "ds-1",
                context: "Three chunks dropped due to detected secrets during last ingest.",
              }),
              reason: "Record secret-redaction incident for ds-1",
            },
          },
        ],
      },
      { content: "Done.", end: true },
    ];
    const { result, calls } = await runWith(
      { objective: "Audit secret incidents", collection_id: "ds-1" },
      script,
      handlers,
    );
    expect(result.kind).toBe("success");
    const createCalls = calls.filter((c) => c.name === "create_memory");
    expect(createCalls).toHaveLength(1);
    const args = createCalls[0].args;
    expect(args.scope).toBe("project");
    const topic = args.topic as { domain: string; subject: string };
    expect(topic.domain).toBe("rag");
    expect(topic.subject).toBe("secret-incidents");
    const body = JSON.parse(String(args.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["collection_id", "context", "count"]);
    expect(body.count).toBe(3);
    expect(body.collection_id).toBe("ds-1");
    expect(typeof body.context).toBe("string");
    // Forbidden fields per analysis §6.
    expect(body).not.toHaveProperty("lastIngestAt");
    expect(body).not.toHaveProperty("paths");
    expect(body).not.toHaveProperty("chunkHashes");
    expect(body).not.toHaveProperty("chunk_hashes");
  });

  it("protected-dataset redirect: knowledge.skills / knowledge.memory route via search_skills / search_memories, not rag_query", async () => {
    const handlers: Record<string, ToolStub> = {
      search_skills: () => ({ hits: [{ id: "skill-1", name: "build-web" }] }),
      search_memories: () => ({ hits: [{ id: "mem-1", topic: "rag/policy" }] }),
    };
    const script: ScriptStep[] = [
      {
        content: "Routing protected-dataset query to skills/memory search.",
        toolCalls: [
          { name: "search_skills", input: { query: "build web", limit: 5 } },
          { name: "search_memories", input: { query: "rag policy", limit: 5 } },
        ],
      },
      {
        content:
          "knowledge.skills and knowledge.memory are protected datasets; results returned via skill/memory search.",
        end: true,
      },
    ];
    const { result, calls } = await runWith(
      {
        objective: "Find guidance in knowledge.skills and knowledge.memory",
        context: "operator asked for skills/memory lookup",
      },
      script,
      handlers,
    );
    expect(result.kind).toBe("success");
    const names = calls.map((c) => c.name);
    expect(names).toContain("search_skills");
    expect(names).toContain("search_memories");
    expect(names).not.toContain("rag_query");
  });

  it("no-hit fallback: empty rag_query triggers a rag/policy memory documenting the miss", async () => {
    const handlers: Record<string, ToolStub> = {
      rag_query: () => ({ hits: [] }),
      create_memory: () => ({ id: "mem-policy-1" }),
    };
    const script: ScriptStep[] = [
      {
        content: "Querying RAG for the miss target.",
        toolCalls: [
          {
            name: "rag_query",
            input: { dataset_id: "ds-2", query: "vector embedding api", limit: 10 },
          },
        ],
      },
      {
        content: "No hits — recording fallback policy memory.",
        toolCalls: [
          {
            name: "create_memory",
            input: {
              topic: { domain: "rag", subject: "policy", aspect: "ds-2" },
              keys: ["ds-2", "retrieval-miss"],
              scope: "project",
              body: JSON.stringify({
                miss: "vector embedding api",
                collection_id: "ds-2",
                recommendation:
                  "ingest upstream docs or expand corpus before re-querying ds-2",
              }),
              reason: "Document RAG retrieval miss for ds-2",
            },
          },
        ],
      },
      { content: "Recommendation recorded.", end: true },
    ];
    const { result, calls } = await runWith(
      {
        objective: "Investigate RAG retrieval miss for ds-2",
        collection_id: "ds-2",
        context: "worker reported zero hits for 'vector embedding api'",
      },
      script,
      handlers,
    );
    expect(result.kind).toBe("success");
    const createCalls = calls.filter((c) => c.name === "create_memory");
    expect(createCalls).toHaveLength(1);
    const topic = createCalls[0].args.topic as { domain: string; subject: string };
    expect(topic.domain).toBe("rag");
    expect(topic.subject).toBe("policy");
    // Fallback memory was written AFTER the rag_query miss.
    const order = calls.map((c) => c.name);
    expect(order.indexOf("rag_query")).toBeLessThan(order.indexOf("create_memory"));
  });
});
