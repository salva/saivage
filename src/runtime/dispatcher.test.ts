import { describe, expect, it } from "vitest";
import { Dispatcher } from "./dispatcher.js";
import type { AgentContext, AgentResult } from "../agents/types.js";
import type { McpRuntime } from "../mcp/runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Dispatcher parallel batch dispatch", () => {
  it("resolves the parent only after every allowed child dispatch settles", async () => {
    const dispatcher = new Dispatcher({} as McpRuntime);
    const coder = deferred<AgentResult>();
    const researcher = deferred<AgentResult>();
    const started: string[] = [];

    dispatcher.setChildSpawner(async (role) => {
      started.push(role);
      return role === "coder" ? coder.promise : researcher.promise;
    });

    const result = dispatcher.processToolCalls(
      [
        { id: "call-coder", name: "run_coder", input: { task: "code" } },
        { id: "call-researcher", name: "run_researcher", input: { task: "research" } },
      ],
      { role: "manager", agentId: "manager-1", project: { projectRoot: "/tmp/project" } } as AgentContext,
    );

    await Promise.resolve();
    expect(started).toEqual(["coder", "researcher"]);

    let settled = false;
    result.then(() => {
      settled = true;
    });

    coder.resolve({ kind: "success", data: { report: "code done" } });
    await Promise.resolve();
    expect(settled).toBe(false);

    researcher.resolve({ kind: "success", data: { report: "research done" } });
    await expect(result).resolves.toMatchObject({
      aborted: false,
      toolResults: [
        { toolUseId: "call-coder", isError: false },
        { toolUseId: "call-researcher", isError: false },
      ],
    });
  });
});

describe("Dispatcher tool resolution", () => {
  it("dispatches aliased runtime tools by original service tool name", async () => {
    const calls: Array<{ serviceName: string; toolName: string }> = [];
    const dispatcher = new Dispatcher({
      getAllTools: () => [
        {
          service: "external-files",
          name: "external-files_read",
          originalName: "read",
          description: "external read",
          inputSchema: { type: "object" },
        },
      ],
      callTool: async (serviceName: string, toolName: string) => {
        calls.push({ serviceName, toolName });
        return { ok: true };
      },
    } as unknown as McpRuntime);

    await expect(dispatcher.processToolCalls(
      [{ id: "call-1", name: "external-files_read", input: { path: "README.md" } }],
      { role: "researcher", agentId: "researcher-1", project: { projectRoot: "/tmp/project" } } as AgentContext,
    )).resolves.toMatchObject({
      toolResults: [{ toolUseId: "call-1", isError: false }],
    });
    expect(calls).toEqual([{ serviceName: "external-files", toolName: "read" }]);
  });

  it("rejects duplicate runtime tool names before dispatching", async () => {
    const dispatcher = new Dispatcher({
      getAllTools: () => [
        { service: "a", name: "search", description: "a", inputSchema: { type: "object" } },
        { service: "b", name: "search", description: "b", inputSchema: { type: "object" } },
      ],
      callTool: async () => ({ ok: true }),
    } as unknown as McpRuntime);

    await expect(dispatcher.processToolCalls(
      [{ id: "call-1", name: "search", input: {} }],
      { role: "researcher", agentId: "researcher-1", project: { projectRoot: "/tmp/project" } } as AgentContext,
    )).resolves.toMatchObject({
      toolResults: [{ toolUseId: "call-1", isError: true, content: "Error: Duplicate runtime tool name 'search'" }],
    });
  });
});
