import type { RagService } from "../../server/rag/service.js";
import { RAG_TOOL_DEFINITIONS, makeRagHandler } from "../../server/rag/handler.js";
import type { McpRuntime } from "../runtime.js";

export function registerRagService(
  mcpRuntime: McpRuntime,
  rag?: RagService,
): boolean {
  if (!rag) return false;

  mcpRuntime.registerInProcess(
    "rag",
    RAG_TOOL_DEFINITIONS,
    makeRagHandler(rag),
  );
  return true;
}
