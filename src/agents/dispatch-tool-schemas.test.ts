import { describe, expect, it } from "vitest";

import { getDispatchToolsForRole } from "./dispatch-tool-schemas.js";

describe("dispatch tool schemas", () => {
  it("does not require runtime-normalized optional fields", () => {
    const plannerTools = new Map(getDispatchToolsForRole("planner").map((tool) => [tool.name, tool]));
    const managerTools = new Map(getDispatchToolsForRole("manager").map((tool) => [tool.name, tool]));

    const managerStage = (((plannerTools.get("run_manager")?.inputSchema as Record<string, unknown>).properties as Record<string, unknown>).stage as Record<string, unknown>);
    expect(managerStage.required).toEqual(["id", "objective", "expected_outcomes", "acceptance_criteria"]);

    const inspectorRequest = (((plannerTools.get("run_inspector")?.inputSchema as Record<string, unknown>).properties as Record<string, unknown>).request as Record<string, unknown>);
    expect(inspectorRequest.required).toEqual(["scope"]);

    const coderTask = (((managerTools.get("run_coder")?.inputSchema as Record<string, unknown>).properties as Record<string, unknown>).task as Record<string, unknown>);
    expect(coderTask.required).toEqual(["id", "objective"]);
  });
});
