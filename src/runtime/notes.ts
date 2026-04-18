/**
 * Saivage — Note Lifecycle
 * Runtime-managed note lifecycle: inject unacknowledged notes into Planner
 * context on resume, set acknowledged_at after Planner's next planning
 * action, delete volatile notes after acknowledgment, re-inject permanent
 * notes after compaction.
 */

import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { readDoc, writeDoc, deleteDoc } from "../store/documents.js";
import { UserNoteSchema, type UserNote } from "../types.js";
import { log } from "../log.js";

/**
 * Manages the lifecycle of user notes.
 */
export class NoteManager {
  private notesDir: string;
  /** Notes that have been injected in the current cycle, pending acknowledgment. */
  private pendingAcknowledgment: string[] = [];

  constructor(notesDir: string) {
    this.notesDir = notesDir;
  }

  /**
   * Get all unacknowledged notes for injection into the Planner's context.
   */
  getUnacknowledgedNotes(): UserNote[] {
    if (!existsSync(this.notesDir)) return [];

    const files = readdirSync(this.notesDir).filter((f) =>
      f.endsWith(".json"),
    );
    const notes: UserNote[] = [];

    for (const file of files) {
      try {
        const note = readDoc(join(this.notesDir, file), UserNoteSchema);
        if (!note.acknowledged_at) {
          notes.push(note);
        }
      } catch {
        // Skip malformed files
      }
    }

    // Track for acknowledgment
    this.pendingAcknowledgment = notes.map((n) => n.id);

    return notes;
  }

  /**
   * Get all permanent notes (for re-injection after compaction).
   */
  getPermanentNotes(): UserNote[] {
    if (!existsSync(this.notesDir)) return [];

    const files = readdirSync(this.notesDir).filter((f) =>
      f.endsWith(".json"),
    );
    const notes: UserNote[] = [];

    for (const file of files) {
      try {
        const note = readDoc(join(this.notesDir, file), UserNoteSchema);
        if (note.permanent) {
          notes.push(note);
        }
      } catch {
        // Skip malformed files
      }
    }

    return notes;
  }

  /**
   * Acknowledge all pending notes.
   * Called after the Planner completes a planning action.
   * Sets acknowledged_at and deletes volatile notes.
   */
  acknowledgeNotes(): void {
    if (this.pendingAcknowledgment.length === 0) return;

    const now = new Date().toISOString();

    for (const noteId of this.pendingAcknowledgment) {
      const path = join(this.notesDir, `${noteId}.json`);
      if (!existsSync(path)) continue;

      try {
        const note = readDoc(path, UserNoteSchema);
        note.acknowledged_at = now;

        if (note.permanent) {
          // Permanent notes: update with acknowledged_at
          writeDoc(path, note, UserNoteSchema);
          log.info(`[notes] Acknowledged permanent note ${noteId}`);
        } else {
          // Volatile notes: delete after acknowledgment
          deleteDoc(path);
          log.info(`[notes] Acknowledged and deleted volatile note ${noteId}`);
        }
      } catch (err) {
        log.warn(`[notes] Failed to acknowledge note ${noteId}: ${err}`);
      }
    }

    this.pendingAcknowledgment = [];
  }

  /**
   * Format notes for injection into the Planner's conversation.
   */
  formatNotesForInjection(notes: UserNote[]): string {
    if (notes.length === 0) return "";

    const parts = notes.map((note) => {
      const urgentTag = note.urgent ? " [URGENT]" : "";
      const permanentTag = note.permanent ? " [PERMANENT]" : "";
      return (
        `--- USER NOTE${urgentTag}${permanentTag} ---\n` +
        `ID: ${note.id}\n` +
        `Channel: ${note.channel}\n` +
        `Created: ${note.created_at}\n` +
        `Content: ${note.content}\n` +
        `---`
      );
    });

    return parts.join("\n\n");
  }

  /**
   * Clean up acknowledged volatile notes that weren't deleted
   * (e.g., after a crash).
   */
  cleanupStaleNotes(): number {
    if (!existsSync(this.notesDir)) return 0;

    const files = readdirSync(this.notesDir).filter((f) =>
      f.endsWith(".json"),
    );
    let cleaned = 0;

    for (const file of files) {
      try {
        const note = readDoc(join(this.notesDir, file), UserNoteSchema);
        if (note.acknowledged_at && !note.permanent) {
          deleteDoc(join(this.notesDir, file));
          cleaned++;
        }
      } catch {
        // Skip malformed files
      }
    }

    if (cleaned > 0) {
      log.info(`[notes] Cleaned up ${cleaned} stale volatile notes`);
    }

    return cleaned;
  }
}
