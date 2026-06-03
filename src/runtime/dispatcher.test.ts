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
