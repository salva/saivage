/**
 * Saivage — Knowledge loader (design §D).
 *
 * Pure functions that classify, score, and budget knowledge records
 * for eager injection. The integration points (BaseAgent ctor, compaction
 * re-inject) land in later milestones; M1 ships these helpers + tests.
 */

import { z } from "zod";

import { redact, scanForSecrets } from "../security/secrets.js";
import type { KnowledgeAgentRole, MemoryRecord, SkillRecord } from "./types.js";

// ─── Canonical normalization (design §D.3) ─────────────────────────────────

/**
 * NFC → lowercase → replace `[^\w\s]` with space → collapse whitespace →
 * split. Returns the token array. Empty input yields `[]`.
 */
export function canonicalizeTokens(text: string | undefined | null): string[] {
  if (!text) return [];
  const normalized = text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) return [];
  return normalized.split(" ");
}

export function canonicalize(text: string | undefined | null): string {
  return canonicalizeTokens(text).join(" ");
}

// ─── Trigger scoring (design §D.1) ─────────────────────────────────────────

export interface SkillMatchContext {
  agentRole: KnowledgeAgentRole;
  description?: string;
  tags?: string[];
}

/**
 * Score a skill's triggers against the agent's task context.
 * Only `keyword:`, `tag:`, and `agent:` forms are supported (§D.4 —
 * `tool:`/`path:` removed; loader ignores leftovers defensively).
 *
 * Returns 0 if no trigger matches; positive score otherwise.
 */
export function scoreSkillTriggers(triggers: readonly string[], ctx: SkillMatchContext): number {
  if (triggers.length === 0) return 0; // triggerless — fall through (§D.1)
  const descTokens = new Set(canonicalizeTokens(ctx.description ?? ""));
  const tagSet = new Set((ctx.tags ?? []).map((t) => canonicalize(t)));
  let score = 0;
  for (const raw of triggers) {
    const idx = raw.indexOf(":");
    if (idx <= 0) continue;
    const kind = raw.slice(0, idx).toLowerCase();
    const value = canonicalize(raw.slice(idx + 1));
    if (value.length === 0) continue;
    if (kind === "keyword") {
      if (descTokens.has(value)) score += 1;
    } else if (kind === "tag") {
      if (tagSet.has(value)) score += 2;
    } else if (kind === "agent") {
      if (value === ctx.agentRole) score += 3;
    }
    // unknown trigger kinds (tool:, path:, anything else) silently ignored
  }
  return score;
}

// ─── On-demand search scoring (design §D.3) ────────────────────────────────

export interface MemoryIndexEntry {
  id: string;
  topic: { domain: string; subject: string; aspect?: string };
  keys: string[];
  body_snippet: string;
  updated_at: string;
}

/**
 * Score a memory record against the normalized query tokens.
 * 3·topic + 2·keys + 1·body_snippet. Returns 0 if no token matches.
 */
export function scoreMemoryForSearch(queryTokens: readonly string[], entry: MemoryIndexEntry): number {
  if (queryTokens.length === 0) return 0;
  const topicTokens = new Set([
    ...canonicalizeTokens(entry.topic.domain),
    ...canonicalizeTokens(entry.topic.subject),
    ...canonicalizeTokens(entry.topic.aspect ?? ""),
  ]);
  const keyTokens = new Set(entry.keys.flatMap((k) => canonicalizeTokens(k)));
  const bodyTokens = new Set(canonicalizeTokens(entry.body_snippet));
  let score = 0;
  for (const q of queryTokens) {
    if (topicTokens.has(q)) score += 3;
    if (keyTokens.has(q)) score += 2;
    if (bodyTokens.has(q)) score += 1;
  }
  return score;
}

export interface SkillIndexEntry {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  body_snippet: string;
  updated_at: string;
  origin?: "builtin" | "project";
  scope?: "project" | "stage" | "session";
}

export function scoreSkillForSearch(queryTokens: readonly string[], entry: SkillIndexEntry): number {
  if (queryTokens.length === 0) return 0;
  const nameTokens = new Set(canonicalizeTokens(entry.name));
  const descTokens = new Set(canonicalizeTokens(entry.description));
  const triggerTokens = new Set(
    entry.triggers.flatMap((t) => {
      const idx = t.indexOf(":");
      return idx > 0 ? canonicalizeTokens(t.slice(idx + 1)) : [];
    }),
  );
  const bodyTokens = new Set(canonicalizeTokens(entry.body_snippet));
  let score = 0;
  for (const q of queryTokens) {
    if (nameTokens.has(q) || triggerTokens.has(q)) score += 3;
    if (descTokens.has(q)) score += 2;
    if (bodyTokens.has(q)) score += 1;
  }
  return score;
}

// ─── Token estimation + budgeting (design §D.2) ────────────────────────────

const SURVIVOR_TOKEN_CEILING = 4096;
const DEFAULT_ORDINARY_BUDGET_TOKENS = 2048;
const SURVIVOR_SUMMARY_BODY_CHARS = 200;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface EagerCandidate {
  kind: "skill" | "memory";
  record: SkillRecord | MemoryRecord;
  score: number;
  body: string; // already loaded (skills load from body_path; memories use .body)
  origin?: "builtin" | "project";
}

export interface EagerResolution {
  survivors: EagerCandidate[];
  ordinary: EagerCandidate[];
  omitted: string[];
  oversizedSurvivors: string[];
}

/**
 * Two-phase budget split. Survivors (survive_compaction == true) ALWAYS
 * included as one-line summaries (no token cap, but per-record ceiling
 * of 4096 tokens — over-ceiling records are quarantined and surfaced
 * via `oversizedSurvivors`). Ordinary records consume `ordinaryBudget`
 * in rank order; overflow goes to `omitted`.
 *
 * Caller is responsible for ranking input (score desc → updated_at desc
 * → id asc). This function does NOT re-sort.
 */
export function splitByBudget(
  ranked: readonly EagerCandidate[],
  ordinaryBudget: number = DEFAULT_ORDINARY_BUDGET_TOKENS,
): EagerResolution {
  const survivors: EagerCandidate[] = [];
  const ordinary: EagerCandidate[] = [];
  const omitted: string[] = [];
  const oversized: string[] = [];

  for (const c of ranked) {
    if (c.record.survive_compaction && c.record.scope === "project") {
      const summary = summarizeForSurvivor(c);
      if (estimateTokens(summary) > SURVIVOR_TOKEN_CEILING) {
        oversized.push(c.record.id);
        continue;
      }
      survivors.push({ ...c, body: summary });
    } else {
      ordinary.push(c);
    }
  }

  let used = 0;
  const accepted: EagerCandidate[] = [];
  for (const c of ordinary) {
    const cost = estimateTokens(c.body);
    if (used + cost > ordinaryBudget) {
      omitted.push(c.record.id);
      continue;
    }
    used += cost;
    accepted.push(c);
  }

  return { survivors, ordinary: accepted, omitted, oversizedSurvivors: oversized };
}

function summarizeForSurvivor(c: EagerCandidate): string {
  if (c.kind === "skill") {
    return (c.record as SkillRecord).description;
  }
  return c.body.slice(0, SURVIVOR_SUMMARY_BODY_CHARS);
}

// ─── resolveEagerRecords + reinjectSurvivors composites ────────────────────

export interface ResolveContext {
  agentRole: KnowledgeAgentRole;
  description?: string;
  tags?: string[];
}

/**
 * Composite: given pre-loaded candidate pools (skills + memories from
 * project / stage / session subtrees + builtin skills), produce the
 * survivor/ordinary/omitted split for the calling agent.
 *
 * Pure function — no I/O. The store layer is responsible for loading
 * records; this just decides which survive eligibility, scoring, and
 * budgeting. M3 will wire it into BaseAgent.
 */
export function resolveEagerRecords(
  ctx: ResolveContext,
  candidates: ReadonlyArray<{
    record: SkillRecord | MemoryRecord;
    body: string;
    origin?: "builtin" | "project";
  }>,
  budget: number = DEFAULT_ORDINARY_BUDGET_TOKENS,
): EagerResolution {
  const eligible: EagerCandidate[] = [];
  for (const cand of candidates) {
    const r = cand.record;
    if (r.status !== "active") continue;
    if (r.target_agents.length > 0 && !r.target_agents.includes(ctx.agentRole)) continue;

    let score: number;
    if (r.kind === "skill") {
      score = scoreSkillTriggers(r.triggers, ctx);
      if (score === 0 && !r.survive_compaction) continue; // triggerless non-survivor → drop
    } else {
      // Memory eager-eligible only if it has target_agents (opt-in).
      if (r.target_agents.length === 0) continue;
      score = 1;
    }

    eligible.push({
      kind: r.kind,
      record: r,
      score,
      body: cand.body,
      origin: cand.origin,
    });
  }

  eligible.sort((a, b) => {
    const oa = a.origin === "builtin" ? 1 : 0;
    const ob = b.origin === "builtin" ? 1 : 0;
    if (oa !== ob) return oa - ob; // project (0) wins
    if (a.score !== b.score) return b.score - a.score;
    if (a.record.updated_at !== b.record.updated_at) return a.record.updated_at < b.record.updated_at ? 1 : -1;
    return a.record.id.localeCompare(b.record.id);
  });

  return splitByBudget(eligible, budget);
}

/**
 * `reinjectSurvivors(projectRoot, agentRole)` — design §E.1 hook.
 * Caller supplies the candidate pool; we just filter survivors and
 * apply per-record summary. Returns the survivor block in injection
 * order (origin-precedence preserved).
 */
export function reinjectSurvivors(
  ctx: ResolveContext,
  candidates: ReadonlyArray<{
    record: SkillRecord | MemoryRecord;
    body: string;
    origin?: "builtin" | "project";
  }>,
): EagerCandidate[] {
  const survivorOnly = candidates.filter(
    (c) =>
      c.record.status === "active" &&
      c.record.survive_compaction &&
      c.record.scope === "project" &&
      (c.record.target_agents.length === 0 || c.record.target_agents.includes(ctx.agentRole)),
  );
  return resolveEagerRecords(ctx, survivorOnly, Number.MAX_SAFE_INTEGER).survivors;
}

// ─── Read-time redaction (design §C.3) ─────────────────────────────────────

/**
 * Read-side defense in depth: even though writes are scrubbed, defensively
 * redact secret-shaped substrings before handing record bodies to the
 * LLM. Returns `{ text, redacted_spans }` (count is exposed in tool
 * responses so the agent knows redaction happened).
 */
export function redactForRead(text: string): { text: string; redacted_spans: number } {
  const matches = scanForSecrets(text, "body").matches;
  return redact(text, matches);
}

// ─── Index-schema helpers (for store layer & tests) ────────────────────────

export const SkillIndexEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  triggers: z.array(z.string()),
  body_snippet: z.string(),
  updated_at: z.string(),
  origin: z.enum(["builtin", "project"]).optional(),
  scope: z.enum(["project", "stage", "session"]).optional(),
});

export const MemoryIndexEntrySchema = z.object({
  id: z.string(),
  topic: z.object({
    domain: z.string(),
    subject: z.string(),
    aspect: z.string().optional(),
  }),
  keys: z.array(z.string()),
  body_snippet: z.string(),
  updated_at: z.string(),
});

export const DEFAULTS = {
  SURVIVOR_TOKEN_CEILING,
  DEFAULT_ORDINARY_BUDGET_TOKENS,
  SURVIVOR_SUMMARY_BODY_CHARS,
} as const;
