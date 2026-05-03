import { describe, expect, it } from "vitest";
import { responsesFunctionCallItemId } from "./responses-ids.js";

describe("responsesFunctionCallItemId", () => {
  it("keeps Responses API function_call item IDs within the 64 character limit", () => {
    const id = responsesFunctionCallItemId("toolu_" + "a".repeat(120));

    expect(id.length).toBeLessThanOrEqual(64);
    expect(id).toMatch(/^fc_/);
  });

  it("is stable and keeps short IDs readable", () => {
    expect(responsesFunctionCallItemId("call_123")).toBe("fc_call_123");
    expect(responsesFunctionCallItemId("x".repeat(100))).toBe(responsesFunctionCallItemId("x".repeat(100)));
  });
});