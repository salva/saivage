import type { FastifyInstance } from "fastify";

export interface NotesReads {
  listNotes(): Promise<unknown[]>;
}

export interface NotesCommands {
  acknowledgeNote(noteId: string): Promise<unknown | null>;
  deleteNote(noteId: string): Promise<boolean>;
  clearNotes(): Promise<number>;
}

export function registerNotesRoutes(
  app: FastifyInstance,
  deps: { reads: NotesReads; commands: NotesCommands },
): void {
  app.get("/api/notes", async () => {
    return { notes: await deps.reads.listNotes() };
  });

  app.post("/api/notes/:noteId/acknowledge", async (req, reply) => {
    const { noteId } = req.params as { noteId: string };
    const result = await deps.commands.acknowledgeNote(noteId);
    if (!result) {
      return reply.status(404).send({ error: "Note not found" });
    }
    return result;
  });

  app.delete("/api/notes/:noteId", async (req, reply) => {
    const { noteId } = req.params as { noteId: string };
    if (!(await deps.commands.deleteNote(noteId))) {
      return reply.status(404).send({ error: "Note not found" });
    }
    return { deleted: true };
  });

  app.delete("/api/notes", async () => {
    return { deleted: await deps.commands.clearNotes() };
  });
}
