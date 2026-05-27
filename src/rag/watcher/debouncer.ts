// F01 B12 — Debouncer for the watcher.
//
// Coalesces filesystem events into a single batch keyed by absolute path,
// flushing after `windowMs` of quiescence. The final event for each path
// is what survives: a `create` followed by a `delete` resolves to
// `{ kind: "delete" }`; a `delete` followed by a `create` resolves to
// `{ kind: "upsert" }`. This matches §3.2.3 of the addendum.

export type DebouncerEvent = { kind: "upsert" | "delete"; path: string };

export interface DebouncerOptions {
  windowMs?: number;
  onFlush: (batch: DebouncerEvent[]) => void;
}

const DEFAULT_WINDOW_MS = 1500;

export class Debouncer {
  private readonly pending = new Map<string, DebouncerEvent["kind"]>();
  private timer: NodeJS.Timeout | null = null;
  private readonly windowMs: number;
  private readonly onFlush: DebouncerOptions["onFlush"];
  private flushing = false;

  constructor(opts: DebouncerOptions) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.onFlush = opts.onFlush;
  }

  push(event: DebouncerEvent): void {
    this.pending.set(event.path, event.kind);
    this.schedule();
  }

  /** Force-flush pending events synchronously. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    this.flushing = true;
    const batch: DebouncerEvent[] = [];
    for (const [path, kind] of this.pending) batch.push({ path, kind });
    this.pending.clear();
    try {
      this.onFlush(batch);
    } finally {
      this.flushing = false;
    }
  }

  /** Cancel any pending flush; drop the in-flight batch. */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }

  private schedule(): void {
    if (this.flushing) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.windowMs);
  }
}
