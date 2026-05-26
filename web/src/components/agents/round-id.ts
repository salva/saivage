function parseDecimalAll(s: string): number | null {
  if (s.length === 0) return null;

  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return null;
    n = n * 10 + (c - 48);
    if (n > Number.MAX_SAFE_INTEGER) return null;
  }

  return n;
}

export type RoundIdShape =
  | { tier: 0; kind: "pre" }
  | { tier: 1; kind: "msg"; index: number }
  | { tier: 2; kind: "round"; index: number }
  | { tier: 3; kind: "compacted"; index: number }
  | { tier: 4; kind: "unknown" };

export function parseRoundId(id: string): RoundIdShape {
  if (id === "r-pre") return { tier: 0, kind: "pre" };

  if (id.startsWith("r-msg:")) {
    const n = parseDecimalAll(id.slice("r-msg:".length));
    if (n !== null) return { tier: 1, kind: "msg", index: n };
    return { tier: 4, kind: "unknown" };
  }

  if (id.startsWith("r-compacted-")) {
    const n = parseDecimalAll(id.slice("r-compacted-".length));
    if (n !== null) return { tier: 3, kind: "compacted", index: n };
    return { tier: 4, kind: "unknown" };
  }

  if (
    id.length >= 2
    && id.charCodeAt(0) === 114
    && id.charCodeAt(1) !== 45
  ) {
    const n = parseDecimalAll(id.slice(1));
    if (n !== null) return { tier: 2, kind: "round", index: n };
  }

  return { tier: 4, kind: "unknown" };
}

export function roundIdSortKey(id: string): [number, number] {
  const parsed = parseRoundId(id);
  if (parsed.kind === "pre" || parsed.kind === "unknown") return [parsed.tier, 0];
  return [parsed.tier, parsed.index];
}
