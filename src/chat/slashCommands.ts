/**
 * Saivage — Chat slash-command parser & router (M2 / WI-09).
 *
 * Per design §H.1 the Chat role exposes 7 read-only slash commands plus
 * two write commands that DO NOT call write tools directly — instead
 * they hand off to the Planner via an inter-agent message (`/note!`
 * urgent permanent note semantics).
 *
 *   /skills list                 → MCP skills.list_skills
 *   /skills show <name-or-id>    → MCP skills.read_skill
 *   /memories list               → MCP memory.list_memories
 *   /memories show <id-or-topic> → MCP memory.get_memory
 *   /memories search <query>     → MCP memory.search_memories
 *   /remember <text>             → Planner inter-agent message
 *   /forget <id>                 → Planner inter-agent message
 *
 * Regression-pin: the runner MUST NOT touch `.saivage/` directly
 * (FA §1.6.4 — Chat is the ONE role with no direct file system reads).
 */

export type ParsedCommand =
  | { kind: "skills_list" }
  | { kind: "skills_show"; argument: string }
  | { kind: "memories_list" }
  | { kind: "memories_show"; argument: string }
  | { kind: "memories_search"; query: string }
  | { kind: "remember"; text: string }
  | { kind: "forget"; id: string };

export interface SlashCommandDeps {
  callTool: (service: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;
  notifyPlanner: (content: string, opts: { permanent?: boolean; urgent?: boolean }) => Promise<string>;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Parse a single user message into a `ParsedCommand` or null if not a recognized slash command. */
export function parseSlashCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  // /skills ...
  const skillsMatch = /^\/skills\s+(list|show)(?:\s+(.+))?$/i.exec(trimmed);
  if (skillsMatch) {
    const sub = skillsMatch[1]!.toLowerCase();
    const arg = (skillsMatch[2] ?? "").trim();
    if (sub === "list") return { kind: "skills_list" };
    if (sub === "show") {
      if (!arg) return null;
      return { kind: "skills_show", argument: arg };
    }
  }

  // /memories ...
  const memoriesMatch = /^\/memories\s+(list|show|search)(?:\s+(.+))?$/i.exec(trimmed);
  if (memoriesMatch) {
    const sub = memoriesMatch[1]!.toLowerCase();
    const arg = (memoriesMatch[2] ?? "").trim();
    if (sub === "list") return { kind: "memories_list" };
    if (sub === "show") {
      if (!arg) return null;
      return { kind: "memories_show", argument: arg };
    }
    if (sub === "search") {
      if (!arg) return null;
      return { kind: "memories_search", query: arg };
    }
  }

  // /remember <text>
  const rememberMatch = /^\/remember\s+(.+)$/i.exec(trimmed);
  if (rememberMatch) {
    return { kind: "remember", text: rememberMatch[1]!.trim() };
  }

  // /forget <id>
  const forgetMatch = /^\/forget\s+(.+)$/i.exec(trimmed);
  if (forgetMatch) {
    return { kind: "forget", id: forgetMatch[1]!.trim() };
  }

  return null;
}

/**
 * Execute a parsed slash command. Reads route through MCP via `deps.callTool`;
 * `/remember` and `/forget` route through `deps.notifyPlanner` ONLY — they
 * never call write tools.
 */
export async function runSlashCommand(parsed: ParsedCommand, deps: SlashCommandDeps): Promise<string> {
  switch (parsed.kind) {
    case "skills_list": {
      const r = await deps.callTool("skills", "list_skills", {});
      return formatJson(r);
    }
    case "skills_show": {
      const arg = parsed.argument;
      const args: Record<string, unknown> = UUID_RE.test(arg) ? { id: arg } : { name: arg };
      const r = await deps.callTool("skills", "read_skill", args);
      return formatJson(r);
    }
    case "memories_list": {
      const r = await deps.callTool("memory", "list_memories", {});
      return formatJson(r);
    }
    case "memories_show": {
      const arg = parsed.argument;
      const args: Record<string, unknown> = UUID_RE.test(arg)
        ? { id: arg }
        : { topic: parseTopic(arg) };
      const r = await deps.callTool("memory", "get_memory", args);
      return formatJson(r);
    }
    case "memories_search": {
      const r = await deps.callTool("memory", "search_memories", { query: parsed.query });
      return formatJson(r);
    }
    case "remember": {
      await deps.notifyPlanner(`/remember ${parsed.text}`, { permanent: true, urgent: false });
      return `Forwarded to Planner: remember "${parsed.text}"`;
    }
    case "forget": {
      await deps.notifyPlanner(`/forget ${parsed.id}`, { permanent: true, urgent: false });
      return `Forwarded to Planner: forget ${parsed.id}`;
    }
  }
}

function parseTopic(arg: string): { domain: string; subject: string; aspect?: string } {
  // Accept "domain/subject" or "domain/subject/aspect".
  const parts = arg.split("/").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3) return { domain: parts[0]!, subject: parts[1]!, aspect: parts[2]! };
  if (parts.length === 2) return { domain: parts[0]!, subject: parts[1]! };
  return { domain: "general", subject: arg };
}

function formatJson(r: unknown): string {
  try {
    return JSON.stringify(r, null, 2);
  } catch {
    return String(r);
  }
}
