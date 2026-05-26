/**
 * Saivage — F30: local slash command dispatcher tests.
 *
 * Validates that `dispatchLocalCommand` covers every entry in
 * `LOCAL_CHAT_COMMANDS`, that alias resolution works, that the help renderer
 * stays in sync with the registry, and that the user-visible reply strings
 * match the expected shape.
 *
 * The compile-time drift guard is the
 * `satisfies Record<LocalChatCommandName, LocalCommandHandler>` clause on
 * `LOCAL_COMMAND_HANDLERS` in `src/chat/localCommands.ts` plus the type
 * derivation of `LocalChatCommandName` from `LOCAL_CHAT_COMMANDS`. This test
 * complements that with runtime coverage.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  LOCAL_CHAT_COMMANDS,
  type LocalChatCommandName,
} from "./localCommandRegistry.js";

vi.mock("../runtime/notes.js", () => ({
  createUserNote: vi.fn((opts: { content: string }) => ({
    id: "note-mock",
    ...opts,
  })),
}));

import { createUserNote } from "../runtime/notes.js";
import {
  dispatchLocalCommand,
  renderLocalHelp,
  restartPlanner,
  MEMORY_SKILL_HELP_ROWS,
  type LocalCommandContext,
} from "./localCommands.js";

interface RestartRequest {
  reason: string;
  requestedBy: string;
  requestedAt: string;
}

function makeCtx(overrides: Partial<LocalCommandContext> = {}): LocalCommandContext & {
  _restartCalls: RestartRequest[];
  _publishCalls: Array<{ type: string; summary: string }>;
} {
  const restartCalls: RestartRequest[] = [];
  const publishCalls: Array<{ type: string; summary: string }> = [];
  const ctx = {
    notesDir: "/tmp/notes",
    channel: "test-channel",
    sessionId: "test-session",
    eventBus: {
      publish: vi.fn(async (e: { type: string; summary: string }) => {
        publishCalls.push(e);
      }),
    } as unknown as LocalCommandContext["eventBus"],
    plannerControl: {
      requestRestart: vi.fn((reason: string, requestedBy: string) => {
        const req: RestartRequest = {
          reason,
          requestedBy,
          requestedAt: "2026-05-24T00:00:00.000Z",
        };
        restartCalls.push(req);
        return req;
      }),
    } as unknown as LocalCommandContext["plannerControl"],
    renderStatus: vi.fn(() => "STATUS_OUT"),
    renderPlan: vi.fn(() => "PLAN_OUT"),
    renderHistory: vi.fn((n: number) => `HISTORY_${n}`),
    ...overrides,
  };
  return Object.assign(ctx as LocalCommandContext, {
    _restartCalls: restartCalls,
    _publishCalls: publishCalls,
  });
}

beforeEach(() => {
  vi.mocked(createUserNote).mockClear();
});

function firstCreatedNoteInput(): Parameters<typeof createUserNote>[0] {
  const input = vi.mocked(createUserNote).mock.calls[0]?.[0];
  if (!input) throw new Error("expected createUserNote to have been called");
  return input;
}

describe("dispatchLocalCommand — registry coverage", () => {
  for (const entry of LOCAL_CHAT_COMMANDS) {
    it(`returns a non-null reply for ${entry.name}`, async () => {
      const ctx = makeCtx();
      // Provide an args body so /note family hits createNote, not the usage hint.
      const input = `${entry.name} hello world`;
      const reply = await dispatchLocalCommand(input, ctx);
      expect(reply).not.toBeNull();
      expect(typeof reply).toBe("string");
      expect((reply as string).length).toBeGreaterThan(0);
    });
  }
});

describe("dispatchLocalCommand — unknown commands", () => {
  it("returns null for an unknown slash command", async () => {
    const reply = await dispatchLocalCommand("/bogus", makeCtx());
    expect(reply).toBeNull();
  });

  it("returns null for non-slash content", async () => {
    const reply = await dispatchLocalCommand("not-a-command", makeCtx());
    expect(reply).toBeNull();
  });

  it("is case-insensitive on the command token", async () => {
    const reply = await dispatchLocalCommand("/HELP", makeCtx());
    expect(reply).not.toBeNull();
    expect(reply).toContain("Available Commands");
  });
});

describe("dispatchLocalCommand — argument handling", () => {
  it("/history with no args defaults to n=5", async () => {
    const ctx = makeCtx();
    await dispatchLocalCommand("/history", ctx);
    expect(ctx.renderHistory).toHaveBeenCalledWith(5);
  });

  it("/history with a number argument uses that number", async () => {
    const ctx = makeCtx();
    await dispatchLocalCommand("/history 12", ctx);
    expect(ctx.renderHistory).toHaveBeenCalledWith(12);
  });

  it("/history with non-numeric args falls back to 5", async () => {
    const ctx = makeCtx();
    await dispatchLocalCommand("/history banana", ctx);
    expect(ctx.renderHistory).toHaveBeenCalledWith(5);
  });

  it("/replan with empty args uses the default replan reason", async () => {
    const ctx = makeCtx();
    await dispatchLocalCommand("/replan", ctx);
    expect(createUserNote).toHaveBeenCalledTimes(1);
    const call = firstCreatedNoteInput();
    expect(call.content).toContain("Re-evaluate the current plan");
    expect(call.permanent).toBe(false);
    expect(call.urgent).toBe(true);
  });

  it("/replan with explicit reason uses that reason", async () => {
    const ctx = makeCtx();
    await dispatchLocalCommand("/replan focus on data quality", ctx);
    const call = firstCreatedNoteInput();
    expect(call.content).toBe("focus on data quality");
    expect(call.urgent).toBe(true);
  });

  it("/note with empty args returns its usage hint", async () => {
    const reply = await dispatchLocalCommand("/note", makeCtx());
    expect(reply).toContain("Usage: `/note <message>`");
    expect(createUserNote).not.toHaveBeenCalled();
  });

  it("/note! with empty args returns its usage hint", async () => {
    const reply = await dispatchLocalCommand("/note!", makeCtx());
    expect(reply).toContain("Usage: `/note! <message>`");
  });

  it("/notep with empty args returns its usage hint", async () => {
    const reply = await dispatchLocalCommand("/notep", makeCtx());
    expect(reply).toContain("Usage: `/notep <message>`");
  });

  it("/note <text> creates a non-permanent, non-urgent note", async () => {
    await dispatchLocalCommand("/note hello there", makeCtx());
    const call = firstCreatedNoteInput();
    expect(call.content).toBe("hello there");
    expect(call.permanent).toBe(false);
    expect(call.urgent).toBe(false);
  });

  it("/notep <text> creates a permanent note", async () => {
    await dispatchLocalCommand("/notep persist this", makeCtx());
    const call = firstCreatedNoteInput();
    expect(call.permanent).toBe(true);
    expect(call.urgent).toBe(false);
  });
});

describe("dispatchLocalCommand — restart-planner alias", () => {
  it("/restart-planner and /planner-restart dispatch identically", async () => {
    const ctxA = makeCtx();
    const ctxB = makeCtx();
    const replyA = await dispatchLocalCommand("/restart-planner please", ctxA);
    const replyB = await dispatchLocalCommand("/planner-restart please", ctxB);
    expect(replyA).toBe(replyB);
    expect(ctxA._restartCalls).toHaveLength(1);
    expect(ctxB._restartCalls).toHaveLength(1);
    const [restartA] = ctxA._restartCalls;
    const [restartB] = ctxB._restartCalls;
    if (!restartA || !restartB) throw new Error("expected restart calls");
    expect(restartA.reason).toBe("please");
    expect(restartB.reason).toBe("please");
  });
});

describe("restartPlanner — without plannerControl", () => {
  it("returns a graceful message when plannerControl is undefined", async () => {
    const ctx = makeCtx({ plannerControl: undefined });
    const reply = await restartPlanner(ctx, "");
    expect(reply).toContain("not available in this runtime");
    expect(ctx._publishCalls).toEqual([]);
  });

  it("publishes a plan_updated event when restart succeeds", async () => {
    const ctx = makeCtx();
    await restartPlanner(ctx, "user wants reset");
    expect(ctx._publishCalls).toHaveLength(1);
    const [published] = ctx._publishCalls;
    if (!published) throw new Error("expected published plan update");
    expect(published.type).toBe("plan_updated");
    expect(published.summary).toContain("user wants reset");
  });
});

describe("createNote reply — no leading emoji glyph (F30)", () => {
  it("does not contain U+1F4DD (MEMO) codepoint", async () => {
    const reply = (await dispatchLocalCommand("/note hello", makeCtx())) as string;
    expect(reply).toMatch(/^Note created:/);
    // 📝 is U+1F4DD; verify the codepoint is absent.
    expect(reply.includes(String.fromCodePoint(0x1f4dd))).toBe(false);
  });
});

describe("renderLocalHelp", () => {
  it("contains exactly one row per LOCAL_CHAT_COMMANDS entry, in order", () => {
    const help = renderLocalHelp();
    let lastIdx = -1;
    for (const cmd of LOCAL_CHAT_COMMANDS) {
      const row = `| \`${cmd.usage}\` | ${cmd.help} |`;
      const idx = help.indexOf(row);
      expect(idx, `row missing: ${row}`).toBeGreaterThan(-1);
      expect(idx, `row out of order: ${row}`).toBeGreaterThan(lastIdx);
      // exactly once
      expect(help.split(row).length - 1).toBe(1);
      lastIdx = idx;
    }
  });

  it("does not list aliases as separate rows", () => {
    const help = renderLocalHelp();
    expect(help).not.toContain("`/planner-restart`");
  });

  it("includes every MEMORY_SKILL_HELP_ROWS entry after the local rows", () => {
    const help = renderLocalHelp();
    let lastIdx = -1;
    const lastLocalCommand = LOCAL_CHAT_COMMANDS.at(-1);
    if (!lastLocalCommand) throw new Error("expected local commands to be non-empty");
    const lastLocalRow = `| \`${lastLocalCommand.usage}\` |`;
    const localEnd = help.indexOf(lastLocalRow);
    for (const row of MEMORY_SKILL_HELP_ROWS) {
      const idx = help.indexOf(row);
      expect(idx).toBeGreaterThan(localEnd);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it("ends with the LLM-fallthrough note as the last non-empty line", () => {
    const help = renderLocalHelp();
    const lines = help.split("\n").filter((l) => l.length > 0);
    expect(lines[lines.length - 1]).toBe(
      "Any other message is handled by the AI assistant.",
    );
  });
});

describe("LocalChatCommandName — type/runtime alignment", () => {
  it("every registry name is a valid LocalChatCommandName at the type level", () => {
    // Sanity: assignability check at compile time. The cast would fail
    // typecheck if `LocalChatCommandName` ever widened to `string`.
    const names: LocalChatCommandName[] = LOCAL_CHAT_COMMANDS.map(
      (c) => c.name,
    );
    expect(names.length).toBe(LOCAL_CHAT_COMMANDS.length);
  });
});
