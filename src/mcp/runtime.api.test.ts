import { describe, it, expect } from "vitest";
import { McpRuntime } from "./runtime.js";

describe("McpRuntime.listAllToolsForApi (WI-12)", () => {
  it("emits available flag for in-process services", () => {
    const rt = new McpRuntime();
    rt.registerInProcess(
      "alpha",
      [{ name: "alpha_do", description: "ok", inputSchema: { type: "object" } }],
      async () => ({ content: [] }),
      { available: true },
    );
    rt.registerInProcess(
      "stub",
      [{ name: "stub_op", description: "stub", inputSchema: { type: "object" } }],
      async () => ({ content: [] }),
      { available: false },
    );
    const out = rt.listAllToolsForApi();
    const alpha = out.find((t) => t.name === "alpha_do");
    const stub = out.find((t) => t.name === "stub_op");
    expect(alpha).toMatchObject({ service: "alpha", available: true });
    expect(stub).toMatchObject({ service: "stub", available: false });
    // projection shape
    expect(Object.keys(alpha!).sort()).toEqual(
      ["available", "description", "inputSchema", "name", "service"].sort(),
    );
  });

  it("does not duplicate tools when same name exists in multiple sources", () => {
    const rt = new McpRuntime();
    rt.registerInProcess(
      "svc1",
      [{ name: "do_thing", description: "d", inputSchema: { type: "object" } }],
      async () => ({ content: [] }),
    );
    const dup = rt.listAllToolsForApi().filter((t) => t.name === "do_thing");
    expect(dup.length).toBe(1);
  });
});
