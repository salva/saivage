import { describe, expect, it } from "vitest";

import { RetryPolicy } from "./retry-policy.js";
import { ProviderError } from "../providers/error.js";

describe("RetryPolicy", () => {
  it("maps context request failures to immediate repair decisions", () => {
    const policy = new RetryPolicy({ transientCap: 3 });

    expect(policy.decide(new ProviderError({ kind: "context_overflow", message: "too long" }), 0)).toMatchObject({
      kind: "repair_context",
      reason: "context window exceeded",
    });
    expect(policy.decide(new ProviderError({ kind: "orphaned_tool_result", message: "orphan" }), 0)).toMatchObject({
      kind: "repair_context",
      reason: "orphaned tool_result",
    });
  });

  it("does not count throttling toward the transient cap and honors retry-after within max delay", () => {
    const policy = new RetryPolicy({ transientCap: 1, baseSeconds: 30, maxSeconds: 1_200 });

    const decision = policy.decide(
      new ProviderError({ kind: "throttling", message: "slow down", retryAfterMs: 45_000 }),
      0,
    );

    expect(decision).toMatchObject({
      kind: "retry",
      delaySec: 45,
      attemptNumber: 1,
      label: "throttled",
      pendingReason: "throttled",
    });
  });

  it("counts non-throttling failures toward the transient cap", () => {
    const policy = new RetryPolicy({ transientCap: 2, baseSeconds: 30 });

    expect(policy.decide(new Error("first"), 0)).toMatchObject({
      kind: "retry",
      delaySec: 30,
      pendingReason: "transient",
    });
    expect(policy.decide(new ProviderError({ kind: "transient", message: "second" }), 1)).toMatchObject({
      kind: "throw",
      error: expect.objectContaining({
        kind: "transient",
        message: "LLM call failed after 2 non-throttling attempts. Last error: second",
      }),
    });
  });
});
