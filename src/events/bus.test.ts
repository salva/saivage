/**
 * Tests for the Event Bus.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus } from "./bus.js";
import type { SystemEvent } from "../types.js";

function makeEvent(
  type: SystemEvent["type"] = "stage_completed",
  summary = "Test event",
  overrides: Partial<SystemEvent> = {},
): SystemEvent {
  return { type, summary, ...overrides };
}

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it("delivers events to subscribers", async () => {
    const received: SystemEvent[] = [];
    bus.subscribe("test", (e) => { received.push(e); });

    await bus.publish(makeEvent("stage_completed", "Done"));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("stage_completed");
  });

  it("delivers to multiple subscribers", async () => {
    const r1: SystemEvent[] = [];
    const r2: SystemEvent[] = [];
    bus.subscribe("s1", (e) => { r1.push(e); });
    bus.subscribe("s2", (e) => { r2.push(e); });

    await bus.publish(makeEvent("plan_updated", "Updated"));

    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });

  it("unsubscribes correctly", async () => {
    const received: SystemEvent[] = [];
    const unsub = bus.subscribe("test", (e) => { received.push(e); });

    await bus.publish(makeEvent());
    expect(received).toHaveLength(1);

    unsub();
    await bus.publish(makeEvent());
    expect(received).toHaveLength(1); // no new events
  });

  it("filters by minSeverity", async () => {
    const received: SystemEvent[] = [];
    bus.subscribe("test", (e) => { received.push(e); }, { minSeverity: "warning" });

    await bus.publish(makeEvent("stage_completed", "info event")); // info — filtered
    await bus.publish(makeEvent("task_failed", "warning event")); // warning — passes
    await bus.publish(makeEvent("stage_failed", "error event")); // error — passes

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe("task_failed");
    expect(received[1].type).toBe("stage_failed");
  });

  it("filters by allowedTypes", async () => {
    const received: SystemEvent[] = [];
    bus.subscribe("test", (e) => { received.push(e); }, {
      allowedTypes: ["stage_completed", "escalation"],
    });

    await bus.publish(makeEvent("stage_completed"));
    await bus.publish(makeEvent("task_failed"));
    await bus.publish(makeEvent("escalation"));

    expect(received).toHaveLength(2);
    expect(received.map((e) => e.type)).toEqual(["stage_completed", "escalation"]);
  });

  it("buffers events when paused", async () => {
    const received: SystemEvent[] = [];
    bus.subscribe("test", (e) => { received.push(e); });

    bus.pause("test");

    await bus.publish(makeEvent("stage_completed", "Event 1"));
    await bus.publish(makeEvent("stage_failed", "Event 2"));

    expect(received).toHaveLength(0);
    expect(bus.getBufferSize("test")).toBe(2);
  });

  it("delivers buffered events on resume", async () => {
    const received: SystemEvent[] = [];
    bus.subscribe("test", (e) => { received.push(e); });

    bus.pause("test");
    await bus.publish(makeEvent("stage_completed", "Event 1"));
    await bus.publish(makeEvent("stage_failed", "Event 2"));

    const delivered = await bus.resume("test");

    expect(delivered).toBe(2);
    expect(received).toHaveLength(2);
    expect(received[0].summary).toBe("Event 1");
    expect(received[1].summary).toBe("Event 2");
    expect(bus.getBufferSize("test")).toBe(0);
  });

  it("drops oldest events when buffer overflows", async () => {
    const received: SystemEvent[] = [];
    bus.subscribe("test", (e) => { received.push(e); }, undefined, 3);

    bus.pause("test");
    await bus.publish(makeEvent("stage_completed", "E1"));
    await bus.publish(makeEvent("stage_completed", "E2"));
    await bus.publish(makeEvent("stage_completed", "E3"));
    await bus.publish(makeEvent("stage_completed", "E4")); // E1 dropped

    expect(bus.getBufferSize("test")).toBe(3);

    const delivered = await bus.resume("test");
    expect(delivered).toBe(3);
    expect(received.map((e) => e.summary)).toEqual(["E2", "E3", "E4"]);
  });

  it("resumes live delivery after resume", async () => {
    const received: SystemEvent[] = [];
    bus.subscribe("test", (e) => { received.push(e); });

    bus.pause("test");
    await bus.publish(makeEvent("stage_completed", "Buffered"));
    await bus.resume("test");

    await bus.publish(makeEvent("plan_updated", "Live"));

    expect(received).toHaveLength(2);
    expect(received[1].summary).toBe("Live");
  });

  it("handles handler errors gracefully", async () => {
    bus.subscribe("test", () => { throw new Error("boom"); });
    bus.subscribe("test2", vi.fn());

    // Should not throw
    await expect(bus.publish(makeEvent())).resolves.toBeUndefined();
  });

  it("bounds buffered handler delivery during resume", async () => {
    vi.useFakeTimers();
    try {
      bus = new EventBus(10);
      bus.subscribe("hung", () => new Promise<void>(() => {}));

      bus.pause("hung");
      await bus.publish(makeEvent("stage_completed", "Buffered"));

      const resumed = bus.resume("hung");
      await vi.advanceTimersByTimeAsync(10);

      await expect(resumed).resolves.toBe(1);
      expect(bus.getBufferSize("hung")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clear removes all subscriptions", async () => {
    const received: SystemEvent[] = [];
    bus.subscribe("test", (e) => { received.push(e); });

    bus.clear();
    await bus.publish(makeEvent());

    expect(received).toHaveLength(0);
  });
});
