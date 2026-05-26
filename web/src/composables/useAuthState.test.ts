import { describe, expect, it, vi } from "vitest";
import { useAuthState } from "./useAuthState";

describe("useAuthState", () => {
  it("starts with unauthorized false", () => {
    const { unauthorized, clearUnauthorized } = useAuthState();
    clearUnauthorized();
    expect(unauthorized.value).toBe(false);
  });

  it("markUnauthorized flips the bit", () => {
    const { unauthorized, markUnauthorized, clearUnauthorized } = useAuthState();
    clearUnauthorized();
    markUnauthorized();
    expect(unauthorized.value).toBe(true);
    clearUnauthorized();
  });

  it("requestRetry clears unauthorized and calls every handler once", () => {
    const { markUnauthorized, requestRetry, onRetry, clearUnauthorized, unauthorized } = useAuthState();
    const h1 = vi.fn();
    const h2 = vi.fn();
    const off1 = onRetry(h1);
    const off2 = onRetry(h2);
    markUnauthorized();
    expect(unauthorized.value).toBe(true);
    requestRetry();
    expect(unauthorized.value).toBe(false);
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    off1();
    off2();
    clearUnauthorized();
  });

  it("onRetry returns an unsubscribe that prevents future calls", () => {
    const { requestRetry, onRetry, clearUnauthorized } = useAuthState();
    const h = vi.fn();
    const off = onRetry(h);
    off();
    requestRetry();
    expect(h).not.toHaveBeenCalled();
    clearUnauthorized();
  });
});
