/**
 * Saivage — Knowledge permissions (design §F).
 *
 * Per-role ACL over knowledge operations. `canCall(role, op, kind)`
 * returns whether the role may invoke the (op, kind) pair at all;
 * `checkScope(role, scope, scope_ref, ctx)` enforces the "Y†" worker
 * scope restriction for Coder/Researcher memory writes.
 *
 * The matrix is hard-coded (one source of truth). The 16 MCP tools in
 * §C.1 dispatch through these two functions only.
 */

import type { KnowledgeAgentRole } from "./types.js";

/** Operations across both kinds (`-S` / `-M` collapsed into kind). */
export type KnowledgeOp =
  | "create"
  | "update"
  | "supersede"
  | "archive"
  | "delete"
  | "read"
  | "list"
  | "search";

export type KnowledgeKind = "skill" | "memory";

/** "yes" / "yes with worker-scope restriction" / "no". */
type AccessCell = "Y" | "Y†" | "-";

/**
 * Permission matrix (§F). Rows = role, columns = `<op>-<kindLetter>`.
 * `update` and `delete` follow `create` and `archive` respectively
 * (note in §F: "delete-* matches archive-*; update-* follows create-*").
 *
 * NB: `read`/`list`/`get` are collapsed under "read" here; `search` is
 * kept separate because data_agent has search-S but no read-M.
 */
const MATRIX: Record<KnowledgeAgentRole, Record<string, AccessCell>> = {
  planner: {
    "create-skill": "-",
    "create-memory": "Y",
    "update-skill": "-",
    "update-memory": "Y",
    "supersede-skill": "-",
    "supersede-memory": "Y",
    "archive-skill": "-",
    "archive-memory": "Y",
    "delete-skill": "-",
    "delete-memory": "Y",
    "read-skill": "Y",
    "read-memory": "Y",
    "list-skill": "Y",
    "list-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
  manager: {
    "create-skill": "Y",
    "create-memory": "Y",
    "update-skill": "Y",
    "update-memory": "Y",
    "supersede-skill": "Y",
    "supersede-memory": "Y",
    "archive-skill": "Y",
    "archive-memory": "Y",
    "delete-skill": "Y",
    "delete-memory": "Y",
    "read-skill": "Y",
    "read-memory": "Y",
    "list-skill": "Y",
    "list-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
  coder: {
    "create-skill": "-",
    "create-memory": "Y†",
    "update-skill": "-",
    "update-memory": "Y†",
    "supersede-skill": "-",
    "supersede-memory": "-",
    "archive-skill": "-",
    "archive-memory": "-",
    "delete-skill": "-",
    "delete-memory": "-",
    "read-skill": "Y",
    "read-memory": "Y",
    "list-skill": "Y",
    "list-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
  researcher: {
    "create-skill": "-",
    "create-memory": "Y†",
    "update-skill": "-",
    "update-memory": "Y†",
    "supersede-skill": "-",
    "supersede-memory": "-",
    "archive-skill": "-",
    "archive-memory": "-",
    "delete-skill": "-",
    "delete-memory": "-",
    "read-skill": "Y",
    "read-memory": "Y",
    "list-skill": "Y",
    "list-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
  data_agent: {
    "create-skill": "-",
    "create-memory": "-",
    "update-skill": "-",
    "update-memory": "-",
    "supersede-skill": "-",
    "supersede-memory": "-",
    "archive-skill": "-",
    "archive-memory": "-",
    "delete-skill": "-",
    "delete-memory": "-",
    "read-skill": "Y",
    "read-memory": "-",
    "list-skill": "Y",
    "list-memory": "-",
    "search-skill": "Y",
    "search-memory": "-",
  },
  inspector: {
    "create-skill": "-",
    "create-memory": "Y",
    "update-skill": "-",
    "update-memory": "Y",
    "supersede-skill": "Y",
    "supersede-memory": "Y",
    "archive-skill": "Y",
    "archive-memory": "Y",
    "delete-skill": "Y",
    "delete-memory": "Y",
    "read-skill": "Y",
    "read-memory": "Y",
    "list-skill": "Y",
    "list-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
  reviewer: {
    "create-skill": "-",
    "create-memory": "-",
    "update-skill": "-",
    "update-memory": "-",
    "supersede-skill": "-",
    "supersede-memory": "-",
    "archive-skill": "-",
    "archive-memory": "-",
    "delete-skill": "-",
    "delete-memory": "-",
    "read-skill": "Y",
    "read-memory": "Y",
    "list-skill": "Y",
    "list-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
  designer: {
    "create-skill": "-",
    "create-memory": "-",
    "update-skill": "-",
    "update-memory": "-",
    "supersede-skill": "-",
    "supersede-memory": "-",
    "archive-skill": "-",
    "archive-memory": "-",
    "delete-skill": "-",
    "delete-memory": "-",
    "read-skill": "Y",
    "read-memory": "Y",
    "list-skill": "Y",
    "list-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
  critic: {
    "create-skill": "-",
    "create-memory": "-",
    "update-skill": "-",
    "update-memory": "-",
    "supersede-skill": "-",
    "supersede-memory": "-",
    "archive-skill": "-",
    "archive-memory": "-",
    "delete-skill": "-",
    "delete-memory": "-",
    "read-skill": "Y",
    "read-memory": "Y",
    "list-skill": "Y",
    "list-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
  chat: {
    "create-skill": "-",
    "create-memory": "-",
    "update-skill": "-",
    "update-memory": "-",
    "supersede-skill": "-",
    "supersede-memory": "-",
    "archive-skill": "-",
    "archive-memory": "-",
    "delete-skill": "-",
    "delete-memory": "-",
    "read-skill": "Y",
    "read-memory": "Y",
    "list-skill": "Y",
    "list-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
  // Librarian (F03 §F): read-only across both kinds, may write memory at
  // project scope only (Y†), and restricted further by topic (see
  // `enforceLibrarianTopic` in mcp/knowledgeMemory.ts).
  librarian: {
    "create-skill": "-",
    "create-memory": "Y†",
    "update-skill": "-",
    "update-memory": "Y†",
    "supersede-skill": "-",
    "supersede-memory": "-",
    "archive-skill": "-",
    "archive-memory": "-",
    "delete-skill": "-",
    "delete-memory": "-",
    "read-skill": "Y",
    "read-memory": "Y",
    "list-skill": "Y",
    "list-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
};

function cellFor(role: KnowledgeAgentRole, op: KnowledgeOp, kind: KnowledgeKind): AccessCell {
  const opForMatrix: string =
    op === "update"
      ? "create"
      : op === "delete"
        ? "archive"
        : op === "list" || op === "read"
          ? "read"
          : op === "search"
            ? "search"
            : op; // create, supersede, archive
  const key = `${opForMatrix}-${kind}`;
  return MATRIX[role]?.[key] ?? "-";
}

/**
 * Return true iff `role` is allowed to call `(op, kind)`. Workers'
 * scope restriction is NOT checked here — call `checkScope` separately
 * after `canCall` returns `true`.
 */
export function canCall(role: KnowledgeAgentRole, op: KnowledgeOp, kind: KnowledgeKind): boolean {
  return cellFor(role, op, kind) !== "-";
}

export type ScopeCheckResult =
  | { ok: true }
  | { ok: false; code: "UNAUTHORIZED_SCOPE"; reason: string };

/**
 * Enforce the worker-scope restriction (Y†): Coder/Researcher may write
 * memory ONLY with `scope=="stage"` AND `scope_ref == ctx.stageId`.
 * Returns `{ok:true}` for all other (role, op, kind) cells, including
 * those where the role is broader (Pl/Mg/In) or where the op is a
 * non-write (read/list/search).
 *
 * Callers MUST first verify with `canCall(...)`; this function assumes
 * the cell is at least "Y" or "Y†".
 */
export function checkScope(
  role: KnowledgeAgentRole,
  op: KnowledgeOp,
  kind: KnowledgeKind,
  scope: "project" | "stage" | "session",
  scope_ref: string | undefined,
  ctx: { stageId?: string; channelId?: string },
): ScopeCheckResult {
  if (cellFor(role, op, kind) !== "Y†") return { ok: true };
  // Librarian Y†: project scope only.
  if (role === "librarian") {
    if (scope === "project") return { ok: true };
    return {
      ok: false,
      code: "UNAUTHORIZED_SCOPE",
      reason: `role=librarian may only write memory with scope='project', got '${scope}'`,
    };
  }
  // Y† for coder/researcher: stage scope tied to current stage.
  if (scope !== "stage") {
    return {
      ok: false,
      code: "UNAUTHORIZED_SCOPE",
      reason: `role=${role} may only write memory with scope='stage', got '${scope}'`,
    };
  }
  if (!ctx.stageId) {
    return {
      ok: false,
      code: "UNAUTHORIZED_SCOPE",
      reason: `role=${role} cannot write stage memory: no active stage context`,
    };
  }
  if (scope_ref !== ctx.stageId) {
    return {
      ok: false,
      code: "UNAUTHORIZED_SCOPE",
      reason: `role=${role} may only write memory with scope_ref='${ctx.stageId}' (current stage), got '${scope_ref ?? ""}'`,
    };
  }
  return { ok: true };
}
