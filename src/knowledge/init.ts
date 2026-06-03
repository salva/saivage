/**
 * F01 B03 — `KnowledgeStore` façade and boot entry.
 *
 * The store is constructed by bootstrap (B07) once the RAG manager and
 * datasets array are available. `initKnowledgeStore` performs the boot
 * sequence specified in design §A.8.
 */
import type { RagManager } from "../rag/index.js";
import type { RuntimeRagDatasetConfig } from "../server/rag/service.js";
import type { SidecarHandle } from "./sidecar.js";

export type RecordKind = "skill" | "memory";

export interface KnowledgeStore {
  readonly sidecar: SidecarHandle;
  readonly ragManager: RagManager;
  /** Shared mutable array — same instance held by `RagService.datasets`. */
  readonly ragDatasets: RuntimeRagDatasetConfig[];
  /** Project root (`<project>/`). */
  readonly projectRoot: string;
  reingestKind(kind: RecordKind): Promise<void>;
}

export interface InitKnowledgeStoreOptions {
  projectRoot: string;
  ragManager: RagManager;
  ragDatasets: RuntimeRagDatasetConfig[];
  ragEnabled: boolean;
}

/**
 * Public init entry. Phases (per design §A.8):
 *  1. assert RAG enabled
 *  2. open sidecar
 *  3. ensure + register protected datasets
 *  4. upsert built-in skills
 *  5. divergence sweep
 *
 * The skeleton in B03 wires the dependency graph; lifecycle and built-ins land
 * in the current sidecar-only store.
 */
export async function initKnowledgeStore(
  opts: InitKnowledgeStoreOptions,
): Promise<KnowledgeStore> {
  if (!opts.ragEnabled) {
    throw new Error(
      "knowledge store requires rag.enabled = true; refusing to boot",
    );
  }
  const { openSidecar } = await import("./sidecar.js");
  const sidecar = await openSidecar(opts.projectRoot);
  const { reingestKind } = await import("./reingest.js");
  const store: KnowledgeStore = {
    sidecar,
    ragManager: opts.ragManager,
    ragDatasets: opts.ragDatasets,
    projectRoot: opts.projectRoot,
    reingestKind: (kind) => reingestKind(store, kind),
  };
  const { upsertBuiltinSkills } = await import("./builtins.js");
  await upsertBuiltinSkills(store);
  return store;
}
