import { ProviderError } from "../providers/error.js";

export interface RetryPolicyConfig {
  transientCap: number;
  baseSeconds?: number;
  multiplier?: number;
  maxSeconds?: number;
}

export type RetryDecision =
  | {
      kind: "repair_context";
      error: ProviderError;
      reason: string;
    }
  | {
      kind: "throw";
      error: ProviderError;
    }
  | {
      kind: "retry";
      error: ProviderError;
      delaySec: number;
      attemptNumber: number;
      label: "failed" | "throttled";
      pendingReason: "transient" | "throttled";
      diagnostic: string;
    };

const DEFAULT_BASE_SECONDS = 30;
const DEFAULT_MULTIPLIER = 1.5;
const DEFAULT_MAX_SECONDS = 20 * 60;

export class RetryPolicy {
  private readonly transientCap: number;
  private readonly baseSeconds: number;
  private readonly multiplier: number;
  private readonly maxSeconds: number;
  private nonThrottleAttempts = 0;

  constructor(config: RetryPolicyConfig) {
    this.transientCap = config.transientCap;
    this.baseSeconds = config.baseSeconds ?? DEFAULT_BASE_SECONDS;
    this.multiplier = config.multiplier ?? DEFAULT_MULTIPLIER;
    this.maxSeconds = config.maxSeconds ?? DEFAULT_MAX_SECONDS;
  }

  decide(err: unknown, attempt: number): RetryDecision {
    const pe = normalizeProviderError(err);

    if (pe.kind === "context_overflow" || pe.kind === "orphaned_tool_result") {
      return {
        kind: "repair_context",
        error: pe,
        reason: pe.kind === "context_overflow"
          ? "context window exceeded"
          : "orphaned tool_result",
      };
    }

    if (pe.kind === "non_retryable") {
      return { kind: "throw", error: pe };
    }

    const throttled = pe.kind === "throttling";
    if (!throttled) {
      this.nonThrottleAttempts += 1;
      if (this.nonThrottleAttempts >= this.transientCap) {
        return {
          kind: "throw",
          error: new ProviderError({
            kind: "transient",
            message: `LLM call failed after ${this.nonThrottleAttempts} non-throttling attempts. Last error: ${truncateDiagnostic(pe.message)}`,
            cause: pe,
          }),
        };
      }
    }

    const expSec = Math.min(
      this.baseSeconds * Math.pow(this.multiplier, attempt),
      this.maxSeconds,
    );
    const retryAfterSec = pe.retryAfterMs ? pe.retryAfterMs / 1000 : 0;
    const delaySec = Math.min(Math.max(expSec, retryAfterSec), this.maxSeconds);
    const attemptNumber = attempt + 1;
    const pendingReason = throttled ? "throttled" : "transient";

    return {
      kind: "retry",
      error: pe,
      delaySec,
      attemptNumber,
      label: throttled ? "throttled" : "failed",
      pendingReason,
      diagnostic: `${throttled ? "Provider throttling" : "Temporary model service issue"} on attempt ${attemptNumber}. Retrying in ${Math.round(delaySec)}s. Error: ${truncateDiagnostic(pe.message)}`,
    };
  }
}

function normalizeProviderError(err: unknown): ProviderError {
  return err instanceof ProviderError
    ? err
    : new ProviderError({
        kind: "transient",
        message: err instanceof Error ? err.message : String(err),
        cause: err,
      });
}

function truncateDiagnostic(value: string, max = 700): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
