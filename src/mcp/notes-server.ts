/**
 * Saivage — Notes MCP Service
 * Allows chat surfaces to create Planner notes through the normal tool path.
 */

import { join } from "node:path";
import type { ToolEntry } from "./types.js";
import { createUserNote } from "../runtime/notes.js";

export class NoteService {
  constructor(private notesDir: string) {}

  async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: unknown; isError: boolean }> {
    if (toolName !== "create_note") {
      return { content: { error: `Unknown notes tool: ${toolName}` }, isError: true };
    }

    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (!content) {
      return { content: { error: "content is required" }, isError: true };
    }

    const note = await createUserNote({
      notesDir: this.notesDir,
      channel: typeof args.channel === "string" ? args.channel : "chat",
      sessionId: typeof args.session_id === "string" ? args.session_id : "tool-create-note",
      content,
      permanent: args.permanent === true,
      urgent: args.urgent === true,
    });

    return {
      content: {
        id: note.id,
        urgent: note.urgent,
        permanent: note.permanent,
        path: join(this.notesDir, `${note.id}.json`),
      },
      isError: false,
    };
  }

  static getToolSchemas(): ToolEntry[] {
    return [
      {
        name: "create_note",
        description: "Create a note for the Planner. Use urgent=true only to mark priority; this does not interrupt running Planner or worker calls.",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "The user instruction or observation to relay to the Planner" },
            permanent: { type: "boolean", description: "Whether the note should persist across future Planner contexts", default: false },
            urgent: { type: "boolean", description: "Whether the Planner should treat this as high-priority when it next sees pending notes", default: false },
            channel: { type: "string", description: "Optional source channel name" },
            session_id: { type: "string", description: "Optional source session id" },
          },
          required: ["content"],
        },
      },
    ];
  }
}