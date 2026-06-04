import { log } from "../log.js";

/** Per-model health state for exponential recovery. */
export interface ModelHealth {
  consecutiveFailures: number;
  disabledUntil: number;
  backoffMs: number;
}

export class ModelHealthTracker {
  /** Initial cooldown after a model's first failure. */
  private static readonly INITIAL_BACKOFF_MS = 15_000;
  /** Backoff multiplier after each subsequent failure. */
  private static readonly BACKOFF_MULTIPLIER = 1.5;
  /** Maximum cooldown duration (10 minutes). */
  private static readonly MAX_BACKOFF_MS = 10 * 60 * 1000;

  private readonly health = new Map<string, ModelHealth>();

  getHealth(spec: string): ModelHealth {
    let h = this.health.get(spec);
    if (!h) {
      h = { consecutiveFailures: 0, disabledUntil: 0, backoffMs: ModelHealthTracker.INITIAL_BACKOFF_MS };
      this.health.set(spec, h);
    }
    return h;
  }

  recordFailure(spec: string, health: ModelHealth): void {
    health.consecutiveFailures++;
    health.disabledUntil = Date.now() + health.backoffMs;
    log.warn(
      `[router] ${spec} disabled for ${Math.round(health.backoffMs / 1000)}s ` +
      `(${health.consecutiveFailures} consecutive failure${health.consecutiveFailures > 1 ? "s" : ""})`,
    );
    health.backoffMs = Math.min(
      health.backoffMs * ModelHealthTracker.BACKOFF_MULTIPLIER,
      ModelHealthTracker.MAX_BACKOFF_MS,
    );
  }

  resetHealth(spec: string): void {
    this.health.delete(spec);
  }

  resetModelHealth(candidates: readonly { healthKey: string }[]): void {
    for (const candidate of candidates) {
      if (this.health.has(candidate.healthKey)) {
        log.info(`[router] Resetting health for ${candidate.healthKey}`);
        this.health.delete(candidate.healthKey);
      }
    }
  }
}
