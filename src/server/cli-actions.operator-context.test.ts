import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOperatorToolContext } from "./cli-actions.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoSrc = path.resolve(here, "..");

describe("operatorContext audit (F02 B03)", () => {
  it("buildOperatorToolContext sets operatorContext: true", () => {
    const ctx = buildOperatorToolContext({
      projectRoot: "/tmp/p",
      agentId: "op-1",
    });
    expect(ctx.operatorContext).toBe(true);
    expect(ctx.role).toBe("planner");
    expect(ctx.projectRoot).toBe("/tmp/p");
  });

  it("dispatcher's toolCtx literal does NOT set operatorContext", async () => {
    const src = await readFile(path.join(repoSrc, "runtime/dispatcher.ts"), "utf-8");
    const m = src.match(/const toolCtx = \{[\s\S]*?\};/);
    expect(m).toBeTruthy();
    if (m) expect(m[0]).not.toMatch(/operatorContext/);
  });

  it("chat slash-command callTool literal does NOT set operatorContext", async () => {
    const src = await readFile(path.join(repoSrc, "agents/chat.ts"), "utf-8");
    const m = src.match(/callTool: \(service, tool, args\) =>[\s\S]*?\}\),/);
    expect(m).toBeTruthy();
    if (m) expect(m[0]).not.toMatch(/operatorContext/);
  });
});
