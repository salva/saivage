/**
 * Saivage — Note Lifecycle
 * Runtime-managed note lifecycle: inject unacknowledged notes into Planner
 * context on resume, set acknowledged_at after Planner's next planning
 * action, delete volatile notes after acknowledgment, re-inject permanent
 * notes after compaction.
 */

import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { readDoc, writeDoc, deleteDoc, ensureDir, pathExists } from "../store/documents.js";
import { UserNoteSchema, type UserNote } from "../types.js";
import { noteId } from "../ids.js";
import { log } from "../log.js";
import type { InputChannel } from "../agents/types.js";

export interface CreateUserNoteInput {
  notesDir: string;
  channel: string;
  sessionId: string;
  content: string;
  permanent: boolean;
  urgent: boolean;
}

export interface NoteMutationResult {
  note: UserNote;
  deleted: boolean;
}

export async function createUserNote(input: CreateUserNoteInput): Promise<UserNote> {
  await ensureDir(input.notesDir);
  const id = noteId();
  const note: UserNote = {
    id,
    channel: input.channel,
    session_id: input.sessionId,
    content: input.content,
    created_at: new Date().toISOString(),
    permanent: input.permanent,
    urgent: input.urgent,
  };
  await writeDoc(join(input.notesDir, `${id}.json`), note, UserNoteSchema);
  return note;
}

/**
 * Manages the lifecycle of user notes.
 */
export class NoteManager {
  private notesDir: string;
  /**
   * IDs of notes that have been delivered to an InputChannel consumer in
   * the current context. Cleared on `resetDelivered()` (called after
   * compaction) so permanent notes can be re-injected into the fresh
   * post-compaction history.
   */
  private delivered = new Set<string>();

  constructor(notesDir: string) {
    this.notesDir = notesDir;
  }

  /**
   * Get all unacknowledged notes without marking them pending for acknowledgment.
   */
  async peekUnacknowledgedNotes(): Promise<UserNote[]> {
    const all = await this.readAllNotes();
    return all
      .filter((note) => !note.acknowledged_at)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /**
   * Drain pending deliverable notes (volatile-unacknowledged + permanent-undelivered).
   * Each returned note is marked delivered until the next `resetDelivered()`.
   */
  async pullDeliverables(): Promise<UserNote[]> {
    const all = await this.readAllNotes();
    const candidates = all
      .filter((note) => !this.delivered.has(note.id))
      .filter((note) => note.permanent || !note.acknowledged_at)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const note of candidates) this.delivered.add(note.id);
    return candidates;
  }

  /** Clear the delivered set so permanent notes become eligible again after compaction. */
  resetDelivered(): void {
    this.delivered.clear();
  }

  async listNotes(): Promise<UserNote[]> {
    const all = await this.readAllNotes();
    return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async acknowledgeNote(noteId: string): Promise<NoteMutationResult | null> {
    const path = join(this.notesDir, `${noteId}.json`);
    if (!(await pathExists(path))) return null;

    try {
      const note = await readDoc(path, UserNoteSchema);
      this.delivered.delete(noteId);

      if (note.permanent) {
        const updated = note.acknowledged_at
          ? note
          : { ...note, acknowledged_at: new Date().toISOString() };
        await writeDoc(path, updated, UserNoteSchema);
        return { note: updated, deleted: false };
      }

      await deleteDoc(path);
      return { note, deleted: true };
    } catch {
      return null;
    }
  }

  async deleteNote(noteId: string): Promise<boolean> {
    const path = join(this.notesDir, `${noteId}.json`);
    if (!(await pathExists(path))) return false;

    try {
      await deleteDoc(path);
      this.delivered.delete(noteId);
      return true;
    } catch {
      return false;
    }
  }

  async clearNotes(): Promise<number> {
    const notes = await this.listNotes();
    const noteIds = notes.map((note) => note.id);
    let deleted = 0;
    for (const noteId of noteIds) {
      if (await this.deleteNote(noteId)) deleted += 1;
    }
    return deleted;
  }

  /**
   * Acknowledge all delivered notes.
   * Called after the Planner completes a planning action.
   * Sets acknowledged_at and deletes volatile notes.
   */
  async acknowledgeNotes(): Promise<void> {
    if (this.delivered.size === 0) return;

    const now = new Date().toISOString();
    const ids = [...this.delivered];

    for (const noteId of ids) {
      const path = join(this.notesDir, `${noteId}.json`);
      if (!(await pathExists(path))) continue;

      try {
        const note = await readDoc(path, UserNoteSchema);
        note.acknowledged_at = now;

        if (note.permanent) {
          // Permanent notes: update with acknowledged_at; keep in `delivered`
          // so they are not re-injected mid-context.
          await writeDoc(path, note, UserNoteSchema);
          log.info(`[notes] Acknowledged permanent note ${noteId}`);
        } else {
          // Volatile notes: delete after acknowledgment.
          await deleteDoc(path);
          this.delivered.delete(noteId);
          log.info(`[notes] Acknowledged and deleted volatile note ${noteId}`);
        }
      } catch (err) {
        log.warn(`[notes] Failed to acknowledge note ${noteId}: ${err}`);
      }
    }
  }

  /**
   * Format notes for injection into the Planner's conversation.
   */
  formatNotesForInjection(notes: UserNote[]): string {
    if (notes.length === 0) return "";

    const orderedNotes = [...notes].sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );

    const parts = orderedNotes.map((note) => {
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

    return [
      "--- USER NOTES FOR PLANNER ---",
      "These notes are ordered oldest to newest. Treat newer and more specific user notes as overriding older, broader notes when they conflict. Urgent means high priority for your next planning decision; it does not mean running work was interrupted unless an explicit Planner restart/abort note says so.",
      ...parts,
      "--- END USER NOTES ---",
    ].join("\n\n");
  }

  /**
   * Clean up acknowledged volatile notes that weren't deleted
   * (e.g., after a crash), and auto-expire unacknowledged volatile notes
   * older than the TTL (default 2 hours). This prevents stale notes from
   * being re-injected indefinitely after restarts.
   */
  async cleanupStaleNotes(ttlMs: number): Promise<number> {
    let files: string[];
    try {
      files = (await readdir(this.notesDir)).filter((f) => f.endsWith(".json"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
    let cleaned = 0;
    const now = Date.now();

    for (const file of files) {
      try {
        const note = await readDoc(join(this.notesDir, file), UserNoteSchema);
        // Remove acknowledged volatile notes (crash recovery)
        if (note.acknowledged_at && !note.permanent) {
          await deleteDoc(join(this.notesDir, file));
          cleaned++;
          continue;
        }
        // Auto-expire unacknowledged volatile notes older than TTL
        if (!note.permanent && !note.acknowledged_at) {
          const age = now - new Date(note.created_at).getTime();
          if (age > ttlMs) {
            await deleteDoc(join(this.notesDir, file));
            log.info(`[notes] Auto-expired volatile note ${note.id} (age ${Math.round(age / 60_000)}min)`);
            cleaned++;
          }
        }
      } catch {
        // Skip malformed files
      }
    }

    if (cleaned > 0) {
      log.info(`[notes] Cleaned up ${cleaned} stale/expired volatile notes`);
    }

    return cleaned;
  }

  private async readAllNotes(): Promise<UserNote[]> {
    let files: string[];
    try {
      files = (await readdir(this.notesDir)).filter((f) => f.endsWith(".json"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const notes: UserNote[] = [];

    for (const file of files) {
      try {
        const note = await readDoc(join(this.notesDir, file), UserNoteSchema);
        if (isPlannerSelfNote(note)) continue;
        notes.push(note);
      } catch {
        // Skip malformed files
      }
    }

    return notes;
  }
}

function isPlannerSelfNote(note: UserNote): boolean {
  return note.channel === "planner";
}

/**
 * InputChannel that drains unacknowledged + undelivered permanent notes
 * from a NoteManager. Resets `delivered` on compaction so permanent notes
 * survive context resets.
 */
export class NoteChannel implements InputChannel {
  constructor(private readonly noteManager: NoteManager) {}

  async drain(): Promise<{ message: string } | null> {
    const notes = await this.noteManager.pullDeliverables();
    if (notes.length === 0) return null;
    return { message: this.noteManager.formatNotesForInjection(notes) };
  }

  onContextReset(): void {
    this.noteManager.resetDelivered();
  }
}
