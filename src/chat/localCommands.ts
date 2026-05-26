/**
 * Saivage — Local Chat Slash Commands (F30)
 *
 * Single source of truth for dispatching the local Chat-handled slash command
 * family (everything except the memory/skill family in `slashCommands.ts`)
 * and for rendering `/help`. The handler table is keyed by the literal-name
 * union derived from `LOCAL_CHAT_COMMANDS` via `satisfies` — drift between
 * the registry and the dispatcher is a typecheck error, not a runtime gap.
 */

import {
  LOCAL_CHAT_COMMANDS,
  type LocalChatCommandName,
} from "./localCommandRegistry.js";
import { createUserNote } from "../runtime/notes.js";
import type { EventBus } from "../events/bus.js";
import type { PlannerControl } from "../server/bootstrap.js";

export interface LocalCommandContext {
  notesDir: string;
  channel: string;
  sessionId: string;
  eventBus: EventBus;
  plannerControl: PlannerControl | undefined;
  renderStatus: () => string | Promise<string>;
  renderPlan: () => string | Promise<string>;
  renderHistory: (n: number) => string | Promise<string>;
}

type LocalCommandHandler = (
  ctx: LocalCommandContext,
  args: string,
) => string | Promise<string>;

const REPLAN_DEFAULT_REASON =
  "User requests replanning. Re-evaluate the current plan, analyze what has failed or escalated, and create a new strategy to achieve the project objectives.";
const USAGE_NOTE = "Usage: `/note <message>` — create a note for the Planner.";
const USAGE_NOTE_URGENT =
  "Usage: `/note! <message>` — create an **urgent** high-priority note.";
const USAGE_NOTEP = "Usage: `/notep <message>` — create a **permanent** note.";

/**
 * The memory/skill family help rows. Routed through
 * `parseSlashCommand`/`runSlashCommand` in `src/chat/slashCommands.ts`; copied
 * here verbatim so `/help` renders them alongside the local commands.
 */
export const MEMORY_SKILL_HELP_ROWS: readonly string[] = [
  "| `/skills list` | List available skills |",
  "| `/skills show <name-or-id>` | Show a skill body |",
  "| `/memories list` | List memory records |",
  "| `/memories show <id-or-topic>` | Show a memory by id or topic |",
  "| `/memories search <query>` | Search memory records |",
  "| `/remember <text>` | Ask the Planner to record a memory |",
  "| `/forget <id>` | Ask the Planner to archive a memory |",
];

const LOCAL_COMMAND_HANDLERS = {
  "/help": () => renderLocalHelp(),
  "/status": (ctx) => ctx.renderStatus(),
  "/plan": (ctx) => ctx.renderPlan(),
  "/history": (ctx, args) => ctx.renderHistory(parseInt(args, 10) || 5),
  "/replan": (ctx, args) =>
    createNote(ctx, args || REPLAN_DEFAULT_REASON, false, true),
  "/restart-planner": (ctx, args) => restartPlanner(ctx, args),
  "/note": (ctx, args) =>
    args ? createNote(ctx, args, false, false) : USAGE_NOTE,
  "/note!": (ctx, args) =>
    args ? createNote(ctx, args, false, true) : USAGE_NOTE_URGENT,
  "/notep": (ctx, args) =>
    args ? createNote(ctx, args, true, false) : USAGE_NOTEP,
} satisfies Record<LocalChatCommandName, LocalCommandHandler>;

function resolveLocalCommand(cmd: string): LocalChatCommandName | undefined {
  for (const c of LOCAL_CHAT_COMMANDS) {
    if (c.name === cmd) return c.name;
    const aliases = (c as { aliases?: readonly string[] }).aliases;
    if (aliases?.includes(cmd)) return c.name;
  }
  return undefined;
}

/**
 * Dispatch a local slash command. Returns the response string, or `null`
 * if `content` is not a recognized local command (let the LLM handle it).
 */
export async function dispatchLocalCommand(
  content: string,
  ctx: LocalCommandContext,
): Promise<string | null> {
  if (!content.startsWith("/")) return null;
  const spaceIdx = content.indexOf(" ");
  const cmd = (spaceIdx === -1 ? content : content.slice(0, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();

  const canonical = resolveLocalCommand(cmd);
  if (!canonical) return null;
  return LOCAL_COMMAND_HANDLERS[canonical](ctx, args);
}

export function renderLocalHelp(): string {
  const localRows = LOCAL_CHAT_COMMANDS.map(
    (c) => `| \`${c.usage}\` | ${c.help} |`,
  );
  return [
    "**Available Commands**",
    "",
    "| Command | Description |",
    "|---------|-------------|",
    ...localRows,
    ...MEMORY_SKILL_HELP_ROWS,
    "",
    "Any other message is handled by the AI assistant.",
  ].join("\n");
}

async function createNote(
  ctx: LocalCommandContext,
  content: string,
  permanent: boolean,
  urgent: boolean,
): Promise<string> {
  const note = await createUserNote({
    notesDir: ctx.notesDir,
    channel: ctx.channel,
    sessionId: ctx.sessionId,
    content,
    permanent,
    urgent,
  });
  const flags = [permanent ? "permanent" : null, urgent ? "urgent" : null]
    .filter(Boolean)
    .join(", ");
  const flagStr = flags ? ` (${flags})` : "";
  return `Note created: \`${note.id}\`${flagStr}\nThe Planner will decide how to handle it when it next sees pending notes.${urgent ? "\nMarked high priority; no running work was interrupted." : ""}`;
}

export async function restartPlanner(
  ctx: LocalCommandContext,
  reason: string,
): Promise<string> {
  if (!ctx.plannerControl) {
    return "Planner restart is not available in this runtime. Use `/replan <reason>` to create an urgent Planner note instead.";
  }
  const restartReason =
    reason || "User explicitly requested a Planner restart from chat.";
  const request = ctx.plannerControl.requestRestart(
    restartReason,
    `${ctx.channel}:${ctx.sessionId}`,
  );
  await ctx.eventBus.publish({
    type: "plan_updated",
    summary: `Planner restart requested from ${ctx.channel}: ${restartReason}`,
  });
  return [
    `Planner restart requested at ${request.requestedAt}.`,
    "The current Planner turn will be cancelled, then a fresh Planner will reload plan/history from disk and continue from persistent state.",
    `Reason: ${restartReason}`,
  ].join("\n");
}
