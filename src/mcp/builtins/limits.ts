export function parseNonNegativeInt(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    raw < 0 ||
    !Number.isInteger(raw)
  ) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return raw;
}
