/**
 * Saivage — F18: LOCAL_CHAT_COMMANDS / renderLocalChatCommandsTable tests.
 *
 * Note: F30 owns deduplication of the runtime switch/cmdHelp paths in chat.ts
 * and slashCommands.ts; this test only validates the catalogue shape.
 */

import { describe, it, expect } from "vitest";

import {
  LOCAL_CHAT_COMMANDS,
  renderLocalChatCommandsTable,
} from "./localCommandRegistry.js";

describe("LOCAL_CHAT_COMMANDS", () => {
  it("is non-empty and well-formed", () => {
    expect(LOCAL_CHAT_COMMANDS.length).toBeGreaterThan(0);
    for (const cmd of LOCAL_CHAT_COMMANDS) {
      expect(cmd.name.startsWith("/")).toBe(true);
      expect(cmd.usage.length).toBeGreaterThan(0);
      expect(cmd.help.length).toBeGreaterThan(0);
    }
  });

  it("has unique command names", () => {
    const names = LOCAL_CHAT_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("renderLocalChatCommandsTable", () => {
  it("lists every command exactly once with its help text", () => {
    const table = renderLocalChatCommandsTable();
    for (const cmd of LOCAL_CHAT_COMMANDS) {
      const occurrences = table.split(cmd.usage).length - 1;
      expect(occurrences).toBe(1);
      expect(table).toContain(cmd.help);
    }
  });
});
