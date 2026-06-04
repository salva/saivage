import type { UsageStatus } from "./types.js";
import { parseModelId } from "./types.js";

export interface UsageSnapshot {
  usedTokens: number | null;
  totalTokens: number | null;
  remainingTokens: number | null;
  remainingRatio: number | null;
  resetAt: Date | null;
  source: "provider" | "config" | "rate-limit" | "unknown";
}

export function describeRequestedModel(modelSpec: string): string {
  const parsed = tryParseModelId(modelSpec);
  if (!parsed) return `model "${modelSpec}"`;
  const { provider, model } = parsed;
  return `model "${model}" via provider "${provider}"`;
}

export function tryParseModelId(modelSpec: string): { provider: string; model: string } | undefined {
  return modelSpec.includes("/") ? parseModelId(modelSpec) : undefined;
}

export function firstModel(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

export function compareUsageSnapshots(a: UsageSnapshot | undefined, b: UsageSnapshot | undefined): number {
  const remainingTokens = compareNullableNumbersDesc(a?.remainingTokens, b?.remainingTokens);
  if (remainingTokens !== 0) return remainingTokens;
  return compareNullableNumbersDesc(a?.remainingRatio, b?.remainingRatio);
}

export function compareNullableNumbersDesc(a: number | null | undefined, b: number | null | undefined): number {
  const aKnown = typeof a === "number" && Number.isFinite(a);
  const bKnown = typeof b === "number" && Number.isFinite(b);
  if (aKnown && bKnown) return b - a;
  if (aKnown) return -1;
  if (bKnown) return 1;
  return 0;
}

export function normalizeUsageSnapshot(status: UsageStatus | null, source: UsageSnapshot["source"]): UsageSnapshot {
  if (!status) return unknownUsageSnapshot();
  const usedTokens = finiteOrNull(status.usedTokens);
  const totalTokens = finiteOrNull(status.totalTokens);
  const explicitRemainingTokens = finiteOrNull(status.remainingTokens);
  const remainingTokens = explicitRemainingTokens ??
    (totalTokens !== null && usedTokens !== null ? Math.max(totalTokens - usedTokens, 0) : null);
  const explicitRemainingRatio = finiteOrNull(status.remainingRatio);
  const remainingRatio = explicitRemainingRatio ??
    (totalTokens && remainingTokens !== null ? clamp01(remainingTokens / totalTokens) : null);

  if (usedTokens === null && totalTokens === null && remainingTokens === null && remainingRatio === null) {
    return unknownUsageSnapshot();
  }

  return {
    usedTokens,
    totalTokens,
    remainingTokens,
    remainingRatio,
    resetAt: status.resetAt ?? null,
    source,
  };
}

export function unknownUsageSnapshot(): UsageSnapshot {
  return {
    usedTokens: null,
    totalTokens: null,
    remainingTokens: null,
    remainingRatio: null,
    resetAt: null,
    source: "unknown",
  };
}

export function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
