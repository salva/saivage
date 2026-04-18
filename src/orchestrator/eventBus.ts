import { log } from "../log.js";

export type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

/**
 * Typed async event bus with wildcard support.
 * Events are strings like "agent:completed", "user:message", etc.
 * Subscribe with exact match or "*" for all events.
 */
export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private wildcardHandlers = new Set<EventHandler>();

  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    if (event === "*") {
      this.wildcardHandlers.add(handler as EventHandler);
      return () => this.wildcardHandlers.delete(handler as EventHandler);
    }

    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as EventHandler);
    return () => set!.delete(handler as EventHandler);
  }

  off(event: string, handler: EventHandler): void {
    if (event === "*") {
      this.wildcardHandlers.delete(handler);
      return;
    }
    this.handlers.get(event)?.delete(handler);
  }

  async emit<T = unknown>(event: string, data: T): Promise<void> {
    const handlers = this.handlers.get(event);
    const all = [
      ...(handlers ? [...handlers] : []),
      ...this.wildcardHandlers,
    ];

    for (const handler of all) {
      try {
        await handler(data);
      } catch (err) {
        log.error(
          `Event handler error for "${event}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  removeAllListeners(event?: string): void {
    if (event === "*") {
      this.wildcardHandlers.clear();
    } else if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
      this.wildcardHandlers.clear();
    }
  }

  listenerCount(event: string): number {
    if (event === "*") return this.wildcardHandlers.size;
    return (this.handlers.get(event)?.size ?? 0) + this.wildcardHandlers.size;
  }
}
