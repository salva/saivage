import { describe, expect, it } from "vitest";

import type { AgentResult } from "../agents/types.js";
import { PlannerControl, type SaivageRuntime } from "./bootstrap.js";
import { PlannerRunner, RECOVERY_PROMPT } from "./planner-runner.js";

describe("PlannerRunner", () => {
  it("queues recovery directive after non-plan_done result and reruns planner", async () => {
    const runtime = makeRuntime({ continuousImprovement: false, recoveryDelayMs: 25 });
    const calls: string[][] = [];
    const waits: number[] = [];
    const results: AgentResult[] = [
      { kind: "failure", reason: "needs retry" },
      { kind: "success", data: { completion: "plan_done", summary: "done" } },
    ];

    const result = await new PlannerRunner(runtime, {
      runPlanner: async () => {
        calls.push([...runtime.plannerStartupDirectives]);
        return results.shift() ?? { kind: "abort", reason: "unexpected extra run" };
      },
      waitForRecoveryDelay: async (ms) => {
        waits.push(ms);
        return false;
      },
    }).runWithRecovery();

    expect(result.kind).toBe("success");
    expect(calls).toEqual([[], [RECOVERY_PROMPT]]);
    expect(waits).toEqual([25]);
    expect(runtime.eventBus.publishCalls).toHaveLength(1);
  });

  it("aborts active planner run and queues restart directive on explicit restart", async () => {
    const runtime = makeRuntime({ continuousImprovement: false, recoveryDelayMs: 0 });
    const abortStates: boolean[] = [];
    const results: AgentResult[] = [
      { kind: "abort", reason: "interrupted for restart" },
      { kind: "success", data: { completion: "plan_done", summary: "done" } },
    ];

    const result = await new PlannerRunner(runtime, {
      runPlanner: async (_runtime, options) => {
        if (abortStates.length === 0) {
          runtime.plannerControl.requestRestart("operator requested", "test");
          abortStates.push(options?.abortSignal?.aborted ?? false);
        }
        return results.shift() ?? { kind: "abort", reason: "unexpected extra run" };
      },
      waitForRecoveryDelay: async () => false,
    }).runWithRecovery();

    expect(result.kind).toBe("success");
    expect(abortStates).toEqual([true]);
    expect(runtime.plannerStartupDirectives[0]).toContain("SYSTEM REQUESTED PLANNER RESTART");
    expect(runtime.eventBus.publishCalls[0]?.summary).toContain("Planner restart requested by test");
  });
});

function makeRuntime(opts: {
  continuousImprovement: boolean;
  recoveryDelayMs: number;
}): SaivageRuntime & { eventBus: SaivageRuntime["eventBus"] & { publishCalls: Array<{ summary?: string }> } } {
  const eventBus = {
    publishCalls: [] as Array<{ summary?: string }>,
    publish: async (event: { summary?: string }) => {
      eventBus.publishCalls.push(event);
    },
  };

  return {
    config: {
      runtime: {
        continuousImprovement: opts.continuousImprovement,
        recoveryDelayMs: opts.recoveryDelayMs,
      },
    } as SaivageRuntime["config"],
    router: {} as SaivageRuntime["router"],
    routing: {} as SaivageRuntime["routing"],
    mcpRuntime: {} as SaivageRuntime["mcpRuntime"],
    eventBus: eventBus as SaivageRuntime["eventBus"] & { publishCalls: Array<{ summary?: string }> },
    planService: {} as SaivageRuntime["planService"],
    noteManager: {} as SaivageRuntime["noteManager"],
    project: {} as SaivageRuntime["project"],
    tracker: {} as SaivageRuntime["tracker"],
    plannerControl: new PlannerControl(),
    plannerStartupDirectives: [],
    agentRegistry: new Map(),
    supervisor: null,
    ragService: {} as SaivageRuntime["ragService"],
    knowledgeStore: {} as SaivageRuntime["knowledgeStore"],
    shutdown: async () => {},
  };
}
