/**
 * Saivage — Abort Mechanism
 * Detect urgent notes → terminate active chain bottom-up →
 * git checkout -- . (tracked files only) → Manager writes partial
 * StageSummary (aborted) → Planner resumes.
 */

import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readDoc } from "../store/documents.js";
import { UserNoteSchema, type UserNote } from "../types.js";
import { log } from "../log.js";

/** Signal object shared with running agents to request abort. */
export interface AbortSignal {
  aborted: boolean;
  reason: string;
  sourceNote?: UserNote;
}

/** Create a new abort signal. */
export function createAbortSignal(): AbortSignal {
  return { aborted: false, reason: "" };
}

/** Trigger the abort signal with a reason. */
export function triggerAbort(
  signal: AbortSignal,
  reason: string,
  note?: UserNote,
): void {
  signal.aborted = true;
  signal.reason = reason;
  signal.sourceNote = note;
  log.warn(`[abort] Abort triggered: ${reason}`);
}

/**
 * Scan the notes directory for urgent unacknowledged notes.
 * Returns the first urgent note found, or null.
 */
export function scanForUrgentNotes(notesDir: string): UserNote | null {
  if (!existsSync(notesDir)) return null;

  const files = readdirSync(notesDir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const note = readDoc(join(notesDir, file), UserNoteSchema);
      if (note.urgent && !note.acknowledged_at) {
        return note;
      }
    } catch {
      // Skip malformed note files
    }
  }
  return null;
}

/**
 * Reset tracked file changes in the working tree.
 * Leaves untracked files for the rollback stage to handle.
 */
export async function resetWorkingTree(
  gitCheckout: (args: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  try {
    await gitCheckout({ ref: ".", cwd: undefined });
    log.info("[abort] Working tree reset (tracked files only)");
  } catch (err) {
    log.warn(`[abort] Failed to reset working tree: ${err}`);
  }
}
