import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

import { createUserNote, NoteManager } from "../runtime/notes.js";
import { registerNotesRoutes } from "./server.js";

describe("G50 /api/notes routes", () => {
  const created: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (created.length > 0) {
      const p = created.pop();
      if (p) rmSync(p, { recursive: true, force: true });
    }
  });

  async function buildApp() {
    const notesDir = mkdtempSync(join(tmpdir(), "saivage-g50-"));
    created.push(notesDir);
    const noteManager = new NoteManager(notesDir);
    const app = Fastify({ logger: false });
    registerNotesRoutes(app, { noteManager });
    await app.ready();
    return { app, noteManager, notesDir };
  }

  it("routes every GET /api/notes through the runtime instance", async () => {
    const { app, noteManager } = await buildApp();
    try {
      const listSpy = vi.spyOn(noteManager, "listNotes");

      const r1 = await app.inject({ method: "GET", url: "/api/notes" });
      const r2 = await app.inject({ method: "GET", url: "/api/notes" });

      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      expect(listSpy).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("routes ack/delete/clear through the runtime instance", async () => {
    const { app, noteManager, notesDir } = await buildApp();
    try {
      const ackSpy = vi.spyOn(noteManager, "acknowledgeNote");
      const deleteSpy = vi.spyOn(noteManager, "deleteNote");
      const clearSpy = vi.spyOn(noteManager, "clearNotes");

      const ackNote = await createUserNote({
        notesDir,
        channel: "test",
        sessionId: "g50",
        content: "ack",
        permanent: true,
        urgent: false,
      });
      const deleteNote = await createUserNote({
        notesDir,
        channel: "test",
        sessionId: "g50",
        content: "delete",
        permanent: false,
        urgent: false,
      });

      const ack = await app.inject({
        method: "POST",
        url: `/api/notes/${ackNote.id}/acknowledge`,
      });
      expect(ack.statusCode).toBe(200);
      expect(ackSpy).toHaveBeenCalledWith(ackNote.id);

      const del = await app.inject({
        method: "DELETE",
        url: `/api/notes/${deleteNote.id}`,
      });
      expect(del.statusCode).toBe(200);
      expect(deleteSpy).toHaveBeenCalledWith(deleteNote.id);

      const clear = await app.inject({ method: "DELETE", url: "/api/notes" });
      expect(clear.statusCode).toBe(200);
      expect(clearSpy).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("preserves delivered-set state across HTTP requests", async () => {
    const { app, noteManager, notesDir } = await buildApp();
    try {
      await createUserNote({
        notesDir,
        channel: "test",
        sessionId: "g50",
        content: "permanent",
        permanent: true,
        urgent: false,
      });

      expect(await noteManager.pullDeliverables()).toHaveLength(1);
      const httpRes = await app.inject({ method: "GET", url: "/api/notes" });
      expect(httpRes.statusCode).toBe(200);
      expect(await noteManager.pullDeliverables()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("only constructs NoteManager in bootstrap and tests", () => {
    const out = execFileSync(
      "grep",
      ["-rln", "new NoteManager", "src/"],
      { encoding: "utf8" },
    );
    const lines = out.split("\n").filter(Boolean).sort();
    expect(lines).toEqual([
      "src/agents/agents.test.ts",
      "src/agents/base.compaction.test.ts",
      "src/agents/chat.lifecycle.test.ts",
      "src/agents/conversation-snapshot.test.ts",
      "src/agents/librarian.behaviour.test.ts",
      "src/agents/librarian.e2e.test.ts",
      "src/agents/librarian.test.ts",
      "src/agents/planner.nudge.test.ts",
      "src/agents/worker-initial-message.test.ts",
      "src/agents/worker-spawn.test.ts",
      "src/runtime/runtime.test.ts",
      "src/server/bootstrap.test.ts",
      "src/server/bootstrap.ts",
      "src/server/dispatcher-gate.test.ts",
      "src/server/server.notes.test.ts",
      "src/server/telegram-bot.test.ts",
    ]);
  });
});
