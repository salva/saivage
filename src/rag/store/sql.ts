// F01 B03 — SQL fragment composition for QueryFilter.
// Pure functions; no I/O. Used by both the query path (filter -> SQL WHERE
// expression, post-applied after the vec MATCH with an internal overshoot
// multiplier) and the delete path (filter -> bulk DELETE WHERE expression).
//
// Indexed columns (see 02-design-r2 §3.1.6): path, source, language, role,
// scope, scopeRef, createdAt, contentHash, sourceHash. `eq` / `in` filters on
// indexed columns can be promoted to a pre-filter candidate-id subquery; all
// other shapes (range / pathGlob / or / mixed and) run as a post-filter with
// overshoot. The store decides; callers do not see this knob.

import type { QueryFilter } from "../types.js";
import { RagError } from "../errors.js";
import { ALLOWED_FILTER_COLUMNS, PREFILTER_ELIGIBLE_COLUMNS } from "./metadata.js";

export interface Compiled {
  sql: string;
  params: Array<string | number | null>;
}

const ALLOWED_COLS = new Set<string>(ALLOWED_FILTER_COLUMNS);
const INDEXED_COLS = new Set<string>(PREFILTER_ELIGIBLE_COLUMNS);

function assertCol(col: string, filter: QueryFilter): void {
  if (!ALLOWED_COLS.has(col)) {
    const detail = { filter, reason: `unknown metadata column "${col}"` };
    throw new RagError("invalid_query_filter", `invalid query filter: ${detail.reason}`, detail);
  }
}

export function compileFilter(filter: QueryFilter): Compiled {
  if ("eq" in filter) {
    const parts: string[] = [];
    const params: Array<string | number | null> = [];
    for (const [col, val] of Object.entries(filter.eq)) {
      assertCol(col, filter);
      if (val === null) {
        parts.push(`${col} IS NULL`);
      } else {
        parts.push(`${col} = ?`);
        params.push(val);
      }
    }
    if (parts.length === 0) return { sql: "1", params: [] };
    return { sql: `(${parts.join(" AND ")})`, params };
  }
  if ("in" in filter) {
    const parts: string[] = [];
    const params: Array<string | number | null> = [];
    for (const [col, vals] of Object.entries(filter.in)) {
      assertCol(col, filter);
      if (!Array.isArray(vals) || vals.length === 0) {
        const detail = { filter, reason: `empty IN list for "${col}"` };
        throw new RagError("invalid_query_filter", `invalid query filter: ${detail.reason}`, detail);
      }
      parts.push(`${col} IN (${vals.map(() => "?").join(", ")})`);
      params.push(...vals);
    }
    return { sql: `(${parts.join(" AND ")})`, params };
  }
  if ("and" in filter) {
    if (filter.and.length === 0) return { sql: "1", params: [] };
    const compiled = filter.and.map(compileFilter);
    return {
      sql: `(${compiled.map((c) => c.sql).join(" AND ")})`,
      params: compiled.flatMap((c) => c.params),
    };
  }
  if ("or" in filter) {
    if (filter.or.length === 0) {
      const detail = { filter, reason: "empty OR list" };
      throw new RagError("invalid_query_filter", `invalid query filter: ${detail.reason}`, detail);
    }
    const compiled = filter.or.map(compileFilter);
    return {
      sql: `(${compiled.map((c) => c.sql).join(" OR ")})`,
      params: compiled.flatMap((c) => c.params),
    };
  }
  if ("gt" in filter) {
    const parts: string[] = [];
    const params: Array<string | number | null> = [];
    for (const [col, n] of Object.entries(filter.gt)) {
      assertCol(col, filter);
      parts.push(`${col} > ?`);
      params.push(n);
    }
    if (filter.lt) {
      for (const [col, n] of Object.entries(filter.lt)) {
        assertCol(col, filter);
        parts.push(`${col} < ?`);
        params.push(n);
      }
    }
    if (parts.length === 0) {
      const detail = { filter, reason: "empty gt/lt filter" };
      throw new RagError("invalid_query_filter", `invalid query filter: ${detail.reason}`, detail);
    }
    return { sql: `(${parts.join(" AND ")})`, params };
  }
  if ("pathGlob" in filter) {
    return { sql: "(path GLOB ?)", params: [filter.pathGlob] };
  }
  const detail = { filter, reason: "unknown discriminant" };
  throw new RagError("invalid_query_filter", `invalid query filter: ${detail.reason}`, detail);
}

// Returns true when the filter shape uses only indexed equality / IN
// predicates connected by AND. Such filters are safe to promote to a
// pre-filter candidate-id subquery.
export function isPreFilterEligible(filter: QueryFilter): boolean {
  if ("eq" in filter) {
    return Object.keys(filter.eq).every((c) => INDEXED_COLS.has(c));
  }
  if ("in" in filter) {
    return Object.keys(filter.in).every((c) => INDEXED_COLS.has(c));
  }
  if ("and" in filter) {
    return filter.and.every(isPreFilterEligible);
  }
  return false;
}
