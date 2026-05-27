/**
 * F02 B04 — `RagService` shape, RAG_TOOLS constant, and scope predicates.
 *
 * The `RagService` is the runtime bag that the in-process `rag` MCP handler
 * closes over. The bootstrap constructs it (B07), `registerBuiltinServices`
 * wires it through (B06), and the per-tool implementations consume it (B05).
 */

import type { RagManager } from "../../rag/manager.js";
import type { DatasetConfig } from "../../rag/types.js";
import type { AgentRole } from "../../agents/types.js";
import type { ToolCallContext } from "../../mcp/toolContext.js";

/** Runtime view of a dataset config (no `projectId`; bootstrap supplies it). */
export type RuntimeRagDatasetConfig = Omit<DatasetConfig, "projectId">;

/** Mutable runtime state shared by the handler and per-tool implementations. */
export interface RagService {
  manager: RagManager;
  /**
   * The same array reference that was passed to `createRagManager`. The
   * manager closes over it for lookups, so all runtime mutations done by
   * `rag_register` and `rag_drop` MUST land here.
   */
  datasets: RuntimeRagDatasetConfig[];
  /** Per-dataset watcher state (`"off"` until `rag_admin watch_arm`). */
  watchStatus: Map<string, "off" | "armed">;
  /** Roles that may invoke admin-scope tools without operator context. */
  adminRoles: Set<AgentRole>;
  /** Single-flight slot for control-scope mutations. */
  control: { busy: boolean };
  /** Mirror of `config.rag.enabled` from bootstrap. */
  enabled: boolean;
  /** Project root used by `saveSaivageConfig`. */
  projectRoot: string;
}

/** Canonical RAG tool surface (analysis §4). */
export const RAG_TOOLS = [
  "rag_list",
  "rag_stats",
  "rag_query",
  "rag_register",
  "rag_ingest",
  "rag_drop",
  "rag_admin",
] as const;

export type RagToolName = (typeof RAG_TOOLS)[number];

const ADMIN_ROLE_TOOLS = new Set<string>([
  "rag_register",
  "rag_ingest",
  "rag_drop",
  "rag_admin",
]);

/** `true` for tools that require operator context OR a role in `adminRoles`. */
export function requiresAdminRole(tool: string): boolean {
  return ADMIN_ROLE_TOOLS.has(tool);
}

/**
 * Control-mutex scope. `rag_ingest` is intentionally NOT here: same-dataset
 * concurrent ingest is already serialised by `RagManager`'s per-dataset
 * ingest lock and surfaces as `RAG_INGEST_LOCKED`; unrelated datasets must
 * be allowed to ingest in parallel.
 */
const CONTROL_TOOLS = new Set<string>(["rag_register", "rag_drop", "rag_admin"]);

export function requiresControlMutex(tool: string): boolean {
  return CONTROL_TOOLS.has(tool);
}

/**
 * Sole authorised reader of `ToolCallContext.operatorContext`. Other call
 * sites MUST go through this helper so the operator-bypass surface stays
 * auditable from one location.
 */
export function isRuntimeOperatorContext(ctx: ToolCallContext): boolean {
  return ctx.operatorContext === true;
}
