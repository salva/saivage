/**
 * Watchdog — detached health-check process that monitors
 * the orchestrator and can trigger rollback on failure.
 */
import { log } from "../log.js";

export interface HealthCheck {
  name: string;
  check: () => Promise<boolean> | boolean;
  interval: number; // ms
}

export class Watchdog {
  private checks: HealthCheck[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private running = false;
  private onFailure: ((checkName: string) => void) | null = null;
  private consecutiveFailures = new Map<string, number>();
  private maxConsecutiveFailures = 3;

  /** Register a health check */
  register(check: HealthCheck): void {
    this.checks.push(check);
  }

  /** Set failure handler */
  setFailureHandler(handler: (checkName: string) => void): void {
    this.onFailure = handler;
  }

  /** Start monitoring */
  start(): void {
    if (this.running) return;
    this.running = true;

    for (const check of this.checks) {
      this.consecutiveFailures.set(check.name, 0);

      const timer = setInterval(async () => {
        try {
          const ok = await check.check();
          if (ok) {
            this.consecutiveFailures.set(check.name, 0);
          } else {
            this.recordFailure(check.name);
          }
        } catch {
          this.recordFailure(check.name);
        }
      }, check.interval);

      this.timers.push(timer);
    }

    log.info(`Watchdog started with ${this.checks.length} checks`);
  }

  /** Stop monitoring */
  stop(): void {
    this.running = false;
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
    log.info("Watchdog stopped");
  }

  private recordFailure(checkName: string): void {
    const count = (this.consecutiveFailures.get(checkName) ?? 0) + 1;
    this.consecutiveFailures.set(checkName, count);
    log.warn(`Health check "${checkName}" failed (${count}/${this.maxConsecutiveFailures})`);

    if (count >= this.maxConsecutiveFailures) {
      log.error(`Health check "${checkName}" exceeded max failures, triggering handler`);
      this.onFailure?.(checkName);
      this.consecutiveFailures.set(checkName, 0); // Reset after trigger
    }
  }
}
