/**
 * F14 regression — PlannerAgent must not duplicate the final assistant message
 * in its conversation when it falls into the no-PLAN_COMPLETE nudge branch.
 * `BaseAgent.runLoop()` already pushes the terminal assistant message; the
 * planner used to push it again before injecting the nudge user message.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PlannerAgent } from "./planner.js";
import { ensureDir } from "../store/documents.js";
import type { AgentContext } from "./types.js";
import type { ChatRequest, ChatResponse } from "../providers/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "saivage-planner-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makePlannerContext(root: string, router: unknown): AgentContext {
  const saivageDir = join(root, ".saivage");
  ensureDir(saivageDir);
  ensureDir(join(saivageDir, "skills"));
  ensureDir(join(saivageDir, "notes"));

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
        planHistory: join(saivageDir, "plan-history.json"),
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
    router: router as AgentContext["router"],
    mcpRuntime: {
      getAllTools: () => [],
      callTool: async () => ({ ok: true }),
    } as AgentContext["mcpRuntime"],
    agentId: "planner-1",
    role: "planner",
    stageId: undefined,
    modelSpec: "test/model",
  };
}

describe("PlannerAgent — nudge path", () => {
  it("does not duplicate the nudged assistant message in this.messages", async () => {
    const calls: ChatRequest[] = [];
    const router = {
      getMaxContextTokens: () => 200_000,
      chat: async (request: ChatRequest): Promise<ChatResponse> => {
        calls.push(request);
        // Call 1: text only, no PLAN_COMPLETE → planner enters nudge branch.
        if (calls.length === 1) {
          return {
            content: "I have nothing else to do.",
            toolCalls: [],
            finishReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        // Call 2: PLAN_COMPLETE → planner exits cleanly.
        return {
          content: "PLAN_COMPLETE",
          toolCalls: [],
          finishReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const ctx = makePlannerContext(tmpDir, router);
    const childSpawner = async () => {
      throw new Error("planner test should not spawn children");
    };

    const planner = new PlannerAgent(ctx, childSpawner);
    const result = await planner.run();

    expect(result.kind).toBe("success");
    expect(calls).toHaveLength(2);

    const assistantTextEquals = (
      m: { role: string; content: unknown },
      target: string,
    ): boolean => {
      if (m.role !== "assistant") return false;
      if (typeof m.content === "string") return m.content === target;
      if (Array.isArray(m.content)) {
        const textBlocks = (m.content as any[])
          .filter((b: any) => b?.type === "text")
          .map((b: any) => b.text ?? "");
        return textBlocks.join("") === target;
      }
      return false;
    };

    // Messages snapshotted on call 2 = state after call 1 returned and nudge
    // was injected. We expect exactly one assistant entry with the call-1 text,
    // followed by a user message starting with "SYSTEM: You ended your turn".
    const msgs = calls[1].messages as any[];
    const count = msgs.filter((m) =>
      assistantTextEquals(m, "I have nothing else to do."),
    ).length;
    expect(count).toBe(1);

    const idx = msgs.findIndex((m) =>
      assistantTextEquals(m, "I have nothing else to do."),
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const next = msgs[idx + 1];
    expect(next?.role).toBe("user");
    const nextContent =
      typeof next.content === "string"
        ? next.content
        : Array.isArray(next.content)
          ? (next.content as any[])
              .filter((b: any) => b?.type === "text")
              .map((b: any) => b.text ?? "")
              .join("")
          : "";
    expect(nextContent.startsWith("SYSTEM: You ended your turn with text only")).toBe(true);
  });
});
