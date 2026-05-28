/**
 * F01 B02 — Private seam for boot-recovery to look up an opened
 * `Dataset` instance from a `RagManager` without leaking the cache
 * through the public API.
 *
 * The hook is installed lazily by `createRagManager` (see
 * `installInternalLookup`) and consumed only by
 * `src/knowledge/recovery.ts`. **This module is intentionally not
 * re-exported from `src/rag/index.ts`.**
 */
import type { RagManager } from "../manager.js";
import type { Dataset } from "../dataset.js";

type Lookup = (id: string) => Dataset | undefined;

const INTERNAL_LOOKUPS = new WeakMap<RagManager, Lookup>();

/** Called from `createRagManager` to register the private lookup. */
export function installInternalLookup(manager: RagManager, lookup: Lookup): void {
  INTERNAL_LOOKUPS.set(manager, lookup);
}

/**
 * Resolve an opened `Dataset` from a manager. Returns `undefined` for
 * unknown ids, the no-op (disabled) manager, or managers built before
 * this seam was installed.
 */
export function getInternalDataset(
  manager: RagManager,
  id: string,
): Dataset | undefined {
  return INTERNAL_LOOKUPS.get(manager)?.(id);
}
