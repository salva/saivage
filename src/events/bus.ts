/**
 * Saivage — Event Bus
 * In-process pub/sub for runtime events. Chat agents subscribe to receive
 * notifications about stage completions, failures, escalations, etc.
 */

import type { SystemEvent } from "../types.js";
import { log } from "../log.js";

/** Subscription callback type. */
export type EventHandler = (event: SystemEvent) => void | Promise<void>;

/** Subscription filter based on user config. */
export interface EventFilter {
  /** Minimum severity to pass. Default: 'info' (all pass). */
  minSeverity?: "info" | "warning" | "error";
  /** Only pass events of these types. Empty or undefined = all. */
  allowedTypes?: SystemEvent["type"][];
}

const SEVERITY_ORDER: Record<string, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

const EVENT_SEVERITY: Record<SystemEvent["type"], string> = {
  stage_completed: "info",
  stage_failed: "error",
  escalation: "warning",
  task_failed: "warning",
  inspector_complete: "info",
  plan_updated: "info",
};

/** Buffered subscription for offline channels. */
interface Subscription {
  id: string;
  handler: EventHandler;
  filter?: EventFilter;
  /** If true, events queue instead of firing immediately. */
  paused: boolean;
  buffer: SystemEvent[];
  maxBuffer: number;
}

/**
 * In-process event bus.
 * - Publish events from the runtime.
 * - Chat agents subscribe on startup.
 * - Supports pause/resume for offline channels with buffering.
 */
export class EventBus {
  private static readonly DEFAULT_HANDLER_TIMEOUT_MS = 5000;
  private subscriptions = new Map<string, Subscription>();

  constructor(private readonly handlerTimeoutMs = EventBus.DEFAULT_HANDLER_TIMEOUT_MS) {}

  /**
   * Subscribe to system events.
   * @returns unsubscribe function.
   */
  subscribe(
    id: string,
    handler: EventHandler,
    filter?: EventFilter,
    maxBuffer = 100,
  ): () => void {
    this.subscriptions.set(id, {
      id,
      handler,
      filter,
      paused: false,
      buffer: [],
      maxBuffer,
    });

    return () => {
      this.subscriptions.delete(id);
    };
  }

  /** Publish an event to all matching subscribers. */
  async publish(event: SystemEvent): Promise<void> {
    log.info(`[event-bus] Publishing: ${event.type} — ${event.summary.slice(0, 80)}`);

    const deliveries: Promise<unknown>[] = [];
    for (const sub of this.subscriptions.values()) {
      if (!passesFilter(event, sub.filter)) continue;

      if (sub.paused) {
        // Buffer for offline channel
        if (sub.buffer.length >= sub.maxBuffer) {
          // Drop oldest
          sub.buffer.shift();
        }
        sub.buffer.push(event);
        continue;
      }

      // Deliver in parallel and bound each handler with a timeout so a
      // single hung subscriber (slow Telegram send, network stall) cannot
      // stall the publisher or block other subscribers.
      deliveries.push(this.deliverWithTimeout(sub, event));
    }

    if (deliveries.length > 0) {
      await Promise.allSettled(deliveries);
    }
  }

  private async deliverWithTimeout(
    sub: Subscription,
    event: SystemEvent,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`handler timed out after ${this.handlerTimeoutMs}ms`)),
        this.handlerTimeoutMs,
      );
    });
    try {
      await Promise.race([
        Promise.resolve().then(() => sub.handler(event)),
        timeout,
      ]);
    } catch (err) {
      log.error(`[event-bus] Handler error for ${sub.id}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Pause a subscription (channel went offline). Events will be buffered. */
  pause(id: string): void {
    const sub = this.subscriptions.get(id);
    if (sub) {
      sub.paused = true;
      log.info(`[event-bus] Paused subscription: ${id}`);
    }
  }

  /**
   * Resume a subscription (channel back online).
   * Delivers buffered events and resumes live delivery.
   * Returns the number of events delivered from the buffer.
   */
  async resume(id: string): Promise<number> {
    const sub = this.subscriptions.get(id);
    if (!sub) return 0;

    sub.paused = false;
    const buffered = sub.buffer.splice(0);

    if (buffered.length > 0) {
      log.info(
        `[event-bus] Resuming ${id}: delivering ${buffered.length} buffered event(s)`,
      );

      for (const event of buffered) await this.deliverWithTimeout(sub, event);
    }

    return buffered.length;
  }

  /** Get the number of buffered events for a subscription. */
  getBufferSize(id: string): number {
    return this.subscriptions.get(id)?.buffer.length ?? 0;
  }

  /** Clear all subscriptions. */
  clear(): void {
    this.subscriptions.clear();
  }
}

function passesFilter(event: SystemEvent, filter?: EventFilter): boolean {
  if (!filter) return true;

  // Check severity
  if (filter.minSeverity) {
    const eventSev = SEVERITY_ORDER[EVENT_SEVERITY[event.type]] ?? 0;
    const minSev = SEVERITY_ORDER[filter.minSeverity] ?? 0;
    if (eventSev < minSev) return false;
  }

  // Check type whitelist
  if (filter.allowedTypes && filter.allowedTypes.length > 0) {
    if (!filter.allowedTypes.includes(event.type)) return false;
  }

  return true;
}
