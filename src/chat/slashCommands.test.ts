import { describe, expect, it, vi } from "vitest";
import { parseSlashCommand, runSlashCommand, type SlashCommandDeps } from "./slashCommands.js";

describe("parseSlashCommand", () => {
  it("parses /skills list", () => {
    expect(parseSlashCommand("/skills list")).toEqual({ kind: "skills_list" });
  });
  it("parses /skills show <name>", () => {
    expect(parseSlashCommand("/skills show build-web")).toEqual({ kind: "skills_show", argument: "build-web" });
  });
  it("parses /memories list", () => {
    expect(parseSlashCommand("/memories list")).toEqual({ kind: "memories_list" });
  });
  it("parses /memories show <id>", () => {
    expect(parseSlashCommand("/memories show 11111111-1111-4111-8111-111111111111"))
      .toEqual({ kind: "memories_show", argument: "11111111-1111-4111-8111-111111111111" });
  });
  it("parses /memories search <query>", () => {
    expect(parseSlashCommand("/memories search build steps"))
      .toEqual({ kind: "memories_search", query: "build steps" });
  });
  it("parses /remember <text>", () => {
    expect(parseSlashCommand("/remember the cat is alive"))
      .toEqual({ kind: "remember", text: "the cat is alive" });
  });
  it("parses /forget <id>", () => {
    expect(parseSlashCommand("/forget abc-123"))
      .toEqual({ kind: "forget", id: "abc-123" });
  });
  it("returns null on unknown command", () => {
    expect(parseSlashCommand("/help")).toBeNull();
    expect(parseSlashCommand("just chat")).toBeNull();
    expect(parseSlashCommand("/skills show")).toBeNull(); // missing arg
  });
});

function makeDeps(): SlashCommandDeps & {
  callTool: ReturnType<typeof vi.fn>;
  notifyPlanner: ReturnType<typeof vi.fn>;
} {
  return {
    callTool: vi.fn().mockResolvedValue({ ok: true }),
    notifyPlanner: vi.fn().mockResolvedValue("note-id-1"),
  };
}

describe("runSlashCommand — routing", () => {
  it("/skills list → callTool(skills, list_skills)", async () => {
    const deps = makeDeps();
    await runSlashCommand({ kind: "skills_list" }, deps);
    expect(deps.callTool).toHaveBeenCalledWith("skills", "list_skills", {});
    expect(deps.notifyPlanner).not.toHaveBeenCalled();
  });

  it("/skills show <uuid> → read_skill {id}", async () => {
    const deps = makeDeps();
    await runSlashCommand({ kind: "skills_show", argument: "11111111-1111-4111-8111-111111111111" }, deps);
    expect(deps.callTool).toHaveBeenCalledWith("skills", "read_skill", { id: "11111111-1111-4111-8111-111111111111" });
  });

  it("/skills show <name> → read_skill {name}", async () => {
    const deps = makeDeps();
    await runSlashCommand({ kind: "skills_show", argument: "build-web" }, deps);
    expect(deps.callTool).toHaveBeenCalledWith("skills", "read_skill", { name: "build-web" });
  });

  it("/memories list → list_memories", async () => {
    const deps = makeDeps();
    await runSlashCommand({ kind: "memories_list" }, deps);
    expect(deps.callTool).toHaveBeenCalledWith("memory", "list_memories", {});
  });

  it("/memories show <uuid> → get_memory {id}", async () => {
    const deps = makeDeps();
    const id = "22222222-2222-4222-8222-222222222222";
    await runSlashCommand({ kind: "memories_show", argument: id }, deps);
    expect(deps.callTool).toHaveBeenCalledWith("memory", "get_memory", { id });
  });

  it("/memories show <topic> → get_memory {topic}", async () => {
    const deps = makeDeps();
    await runSlashCommand({ kind: "memories_show", argument: "build/web-app" }, deps);
    expect(deps.callTool).toHaveBeenCalledWith("memory", "get_memory", {
      topic: { domain: "build", subject: "web-app" },
    });
  });

  it("/memories search <q> → search_memories {query}", async () => {
    const deps = makeDeps();
    await runSlashCommand({ kind: "memories_search", query: "deploy" }, deps);
    expect(deps.callTool).toHaveBeenCalledWith("memory", "search_memories", { query: "deploy" });
  });

  it("/remember calls notifyPlanner ONLY (no callTool)", async () => {
    const deps = makeDeps();
    await runSlashCommand({ kind: "remember", text: "hello" }, deps);
    expect(deps.notifyPlanner).toHaveBeenCalledWith("/remember hello", { permanent: true, urgent: false });
    expect(deps.callTool).not.toHaveBeenCalled();
  });

  it("/forget calls notifyPlanner ONLY (no callTool)", async () => {
    const deps = makeDeps();
    await runSlashCommand({ kind: "forget", id: "abc" }, deps);
    expect(deps.notifyPlanner).toHaveBeenCalledWith("/forget abc", { permanent: true, urgent: false });
    expect(deps.callTool).not.toHaveBeenCalled();
  });
});
