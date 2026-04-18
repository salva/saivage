import { describe, it, expect, vi, afterEach } from "vitest";
import { Watchdog } from "./watchdog.js";

describe("Watchdog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects failures and triggers handler", async () => {
    const watchdog = new Watchdog();
    const handler = vi.fn();
    let callCount = 0;

    watchdog.register({
      name: "test-check",
      check: () => {
        callCount++;
        return false; // always fail
      },
      interval: 10,
    });

    watchdog.setFailureHandler(handler);
    watchdog.start();

    // Wait for enough intervals to trigger failure (3 consecutive)
    await new Promise((r) => setTimeout(r, 150));
    watchdog.stop();

    expect(handler).toHaveBeenCalledWith("test-check");
  });

  it("resets failure count on success", async () => {
    const watchdog = new Watchdog();
    const handler = vi.fn();
    let callCount = 0;

    watchdog.register({
      name: "flapping-check",
      check: () => {
        callCount++;
        // Fail twice, then succeed, fail twice, succeed...
        return callCount % 3 === 0;
      },
      interval: 10,
    });

    watchdog.setFailureHandler(handler);
    watchdog.start();

    await new Promise((r) => setTimeout(r, 200));
    watchdog.stop();

    // Should never reach 3 consecutive failures due to periodic success
    expect(handler).not.toHaveBeenCalled();
  });
});
