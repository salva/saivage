export interface LocalChatCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly usage: string;
  readonly help: string;
}

/**
 * Local Chat-handled slash commands. The memory/skill family
 * (`/skills`, `/memories`, `/remember`, `/forget`) is routed through
 * `parseSlashCommand` in `src/chat/slashCommands.ts` and is intentionally
 * NOT listed here — that subsystem is owned separately.
 */
export const LOCAL_CHAT_COMMANDS = [
  { name: "/help",            usage: "/help",                     help: "Show this help message" },
  { name: "/status",          usage: "/status",                   help: "Show runtime status (agents, current stage)" },
  { name: "/plan",            usage: "/plan",                     help: "Show the current plan with all stages" },
  { name: "/history",         usage: "/history [n]",              help: "Show completed stages (last n, default 5)" },
  { name: "/replan",          usage: "/replan [reason]",          help: "Force replanning (urgent note to Planner)" },
  { name: "/restart-planner", aliases: ["/planner-restart"],
                              usage: "/restart-planner [reason]", help: "Restart the Planner from persisted state" },
  { name: "/note",            usage: "/note <msg>",               help: "Create a note for the Planner" },
  { name: "/note!",           usage: "/note! <msg>",              help: "Create an **urgent** high-priority note" },
  { name: "/notep",           usage: "/notep <msg>",              help: "Create a **permanent** note" },
] as const satisfies readonly LocalChatCommand[];

export type LocalChatCommandName = (typeof LOCAL_CHAT_COMMANDS)[number]["name"];

export function renderLocalChatCommandsTable(): string {
  return LOCAL_CHAT_COMMANDS
    .map((c) => `- \`${c.usage}\` — ${c.help}`)
    .join("\n");
}
