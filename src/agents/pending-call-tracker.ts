import type { ActivityStatus } from "./base.js";

type PendingCall = NonNullable<ActivityStatus["pending_call"]>;

export class PendingCallTracker {
  private pendingCall: PendingCall | null = null;

  startInFlight(attempt: number): void {
    this.pendingCall = {
      started_at: new Date().toISOString(),
      status: "in_flight",
      attempt,
      reason: null,
      retry_at: null,
    };
  }

  startBackoff(args: { attempt: number; reason: PendingCall["reason"]; retryAt: string }): void {
    this.pendingCall = {
      started_at: this.pendingCall?.started_at ?? new Date().toISOString(),
      status: "backoff",
      attempt: args.attempt,
      reason: args.reason,
      retry_at: args.retryAt,
    };
  }

  clear(): void {
    this.pendingCall = null;
  }

  snapshot(): PendingCall | null {
    return this.pendingCall ? { ...this.pendingCall } : null;
  }
}
