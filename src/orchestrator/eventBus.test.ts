import { describe, it, expect, vi } from "vitest";
import { EventBus } from "./eventBus.js";

describe("EventBus", () => {
  it("emits to subscribed handlers", async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("test:event", handler);

    await bus.emit("test:event", { foo: 1 });
    expect(handler).toHaveBeenCalledWith({ foo: 1 });
  });

  it("does not call handlers for other events", async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("test:a", handler);

    await bus.emit("test:b", {});
    expect(handler).not.toHaveBeenCalled();
  });

  it("wildcard receives all events", async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("*", handler);

    await bus.emit("test:a", 1);
    await bus.emit("test:b", 2);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(1);
    expect(handler).toHaveBeenCalledWith(2);
  });

  it("unsubscribe via returned function", async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const unsub = bus.on("test:event", handler);

    unsub();
    await bus.emit("test:event", {});
    expect(handler).not.toHaveBeenCalled();
  });

  it("error isolation — one handler failure does not break others", async () => {
    const bus = new EventBus();
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();

    bus.on("test:event", bad);
    bus.on("test:event", good);

    await bus.emit("test:event", {});
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  it("listenerCount", () => {
    const bus = new EventBus();
    bus.on("test:a", () => {});
    bus.on("test:a", () => {});
    bus.on("*", () => {});

    expect(bus.listenerCount("test:a")).toBe(3); // 2 specific + 1 wildcard
    expect(bus.listenerCount("test:b")).toBe(1); // just wildcard
  });

  it("removeAllListeners", async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("test:a", handler);
    bus.on("*", handler);

    bus.removeAllListeners();
    await bus.emit("test:a", {});
    expect(handler).not.toHaveBeenCalled();
  });
});
