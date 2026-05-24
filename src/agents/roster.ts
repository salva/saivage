/**
 * Saivage — Agent Roster
 *
 * Single declarative source of truth for every agent role. All schema enums,
 * dispatch maps, tool filters, abort priorities, self-check frequencies,
 * conventions, model-key bindings, and the per-prompt role summary block are
 * derived from this file. Adding a role here is the only edit needed to make
 * it visible to schemas, the dispatcher, the supervisor, and prompts.
 */

import type { ConventionRule } from "./conventions.js";

export type ToolFilterKind = "planner" | "worker" | "reviewer" | "inspector" | "chat";

export interface RosterEntry {
  /** Canonical role identifier used throughout the codebase. */
  role: string;
  /** Whether this role is a stage-scoped worker (assignable via TaskSchema). */
  worker: boolean;
  /** Dispatch tool name a parent uses to spawn this role, or null if not dispatchable. */
  dispatchTool: string | null;
  /** Roles that may dispatch this role via the dispatch tool. */
  dispatchableBy: string[];
  /** Tool-filter strategy applied by `getToolsForRole`. */
  toolFilter: ToolFilterKind;
  /** Lower numbers are aborted first by the supervisor; null means not abortable. */
  abortPriority: number | null;
  /** Default self-check frequency (rounds between checks); 0 disables. */
  selfCheckFrequency: number;
  /** Territory rule for `checkConvention`; null means no convention. */
  convention: ConventionRule | null;
  /** Config `models.<key>` slot this role resolves to. */
  defaultModelKey: string;
  /** Display name used in `renderRosterSummary`. */
  displayName: string;
  /** Prompt summary used by every agent's "## The Saivage System" section. */
  summary: string;
}

export const ROSTER = [
  {
    role: "planner",
    worker: false,
    dispatchTool: null,
    dispatchableBy: [],
    toolFilter: "planner",
    abortPriority: null,
    selfCheckFrequency: 30,
    convention: {
      writeTerritory: [".saivage/plan.json", ".saivage/plan-history.json"],
      excludeTerritory: ["src/", "research/"],
      description: "Planner manages plan state via Plan MCP only",
    },
    defaultModelKey: "orchestrator",
    displayName: "Planner",
    summary:
      "The top-level strategist. Owns the project plan — a sequence of stages — and drives the project from its current state to its declared objectives. Long-lived; thinks in stages, not code.",
  },
  {
    role: "manager",
    worker: false,
    dispatchTool: "run_manager",
    dispatchableBy: ["planner"],
    toolFilter: "worker",
    abortPriority: 5,
    selfCheckFrequency: 20,
    convention: {
      writeTerritory: [".saivage/stages/"],
      excludeTerritory: ["src/", "research/"],
      description: "Manager writes task lists and summaries under .saivage/stages/",
    },
    defaultModelKey: "orchestrator",
    displayName: "Manager",
    summary:
      "A tactical executor scoped to one stage. Decomposes a stage into tasks, dispatches Coder/Researcher/Data Agent/Reviewer workers, supervises them, handles retries, and returns a `StageSummary`. Ephemeral.",
  },
  {
    role: "coder",
    worker: true,
    dispatchTool: "run_coder",
    dispatchableBy: ["manager"],
    toolFilter: "worker",
    abortPriority: 3,
    selfCheckFrequency: 15,
    convention: {
      writeTerritory: ["src/", "tests/", "test/", "package.json", "tsconfig.json"],
      excludeTerritory: ["research/"],
      description: "Coder should write project source code, not research docs",
    },
    defaultModelKey: "coder",
    displayName: "Coder",
    summary:
      "A one-shot coding agent. Receives a task, writes/modifies code, runs tests, commits changes, and returns a `TaskReport`. Does not plan or coordinate — executes.",
  },
  {
    role: "researcher",
    worker: true,
    dispatchTool: "run_researcher",
    dispatchableBy: ["manager"],
    toolFilter: "worker",
    abortPriority: 4,
    selfCheckFrequency: 15,
    convention: {
      writeTerritory: ["research/"],
      excludeTerritory: ["src/"],
      description: "Researcher should write under research/, not project source",
    },
    defaultModelKey: "researcher",
    displayName: "Researcher",
    summary:
      "A one-shot information-gathering agent. Searches the web, reads documentation, organizes findings under `research/`, and returns a `TaskReport`. Does not write code.",
  },
  {
    role: "data_agent",
    worker: true,
    dispatchTool: "run_data_agent",
    dispatchableBy: ["manager"],
    toolFilter: "worker",
    abortPriority: 2,
    selfCheckFrequency: 15,
    convention: {
      writeTerritory: ["data/", "research/data-sources/", ".saivage/stages/"],
      excludeTerritory: ["src/"],
      description:
        "Data Agent should write data artifacts, provenance notes, and reports, not project source",
    },
    defaultModelKey: "data_agent",
    displayName: "Data Agent",
    summary:
      "A one-shot data acquisition specialist. Searches for data sources, downloads files or API data, validates artifacts, records provenance, and returns a `TaskReport`.",
  },
  {
    role: "reviewer",
    worker: true,
    dispatchTool: "run_reviewer",
    dispatchableBy: ["manager"],
    toolFilter: "reviewer",
    abortPriority: 1,
    selfCheckFrequency: 15,
    convention: {
      writeTerritory: [".saivage/stages/", "reviews/", "reports/"],
      excludeTerritory: ["src/", "data/", "research/"],
      description:
        "Reviewer should write review findings and reports, not implementation, research, or data artifacts",
    },
    defaultModelKey: "reviewer",
    displayName: "Reviewer",
    summary:
      "A stage-scoped quality gate. Reviews worker outputs at end of stage and persists across the stage so follow-up review requests build on earlier findings. Returns a `TaskReport`.",
  },
  {
    role: "inspector",
    worker: false,
    dispatchTool: "run_inspector",
    dispatchableBy: ["planner", "chat"],
    toolFilter: "inspector",
    abortPriority: null,
    selfCheckFrequency: 15,
    convention: {
      writeTerritory: [
        ".saivage/inspections/",
        ".saivage/tools/inspector/",
        ".saivage/tmp/inspector-workspace/",
      ],
      excludeTerritory: ["src/"],
      description: "Inspector writes reports and tools, not source code",
    },
    defaultModelKey: "orchestrator",
    displayName: "Inspector",
    summary:
      "A one-shot deep-analysis agent. Investigates project state, failure root causes, or architecture and returns an `InspectionReport` with findings, evidence, and recommendations.",
  },
  {
    role: "chat",
    worker: false,
    dispatchTool: null,
    dispatchableBy: [],
    toolFilter: "chat",
    abortPriority: null,
    selfCheckFrequency: 0,
    convention: {
      writeTerritory: [".saivage/notes/", ".saivage/tmp/chats/"],
      excludeTerritory: ["src/", "research/"],
      description: "Chat only creates notes and chat logs",
    },
    defaultModelKey: "chat",
    displayName: "Chat",
    summary:
      "The user-facing surface. Answers user questions about project state, relays user direction to the Planner via notes, pushes notifications about significant events, and may dispatch the Inspector for deep investigations.",
  },
] as const satisfies readonly RosterEntry[];

export type AgentRole = (typeof ROSTER)[number]["role"];
export type WorkerRole = Extract<(typeof ROSTER)[number], { worker: true }>["role"];
export type DispatchableRole = Extract<
  (typeof ROSTER)[number],
  { dispatchTool: string }
>["role"];

function buildEnumTuple<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  if (values.length === 0) {
    throw new Error("ROSTER must contain at least one entry");
  }
  return values as unknown as readonly [T, ...T[]];
}

export const ALL_ROLES = buildEnumTuple(ROSTER.map((entry) => entry.role) as AgentRole[]);

export const WORKER_ROLES = buildEnumTuple(
  ROSTER.filter((entry) => entry.worker).map((entry) => entry.role) as WorkerRole[],
);

export const DISPATCHABLE_ROLES = buildEnumTuple(
  ROSTER.filter((entry) => entry.dispatchTool !== null).map(
    (entry) => entry.role,
  ) as DispatchableRole[],
);

const ROSTER_BY_ROLE: Map<string, RosterEntry> = new Map(
  ROSTER.map((entry) => [entry.role, entry as unknown as RosterEntry]),
);

const ROSTER_BY_DISPATCH_TOOL: Map<string, RosterEntry> = new Map(
  ROSTER.filter((entry) => entry.dispatchTool !== null).map((entry) => [
    entry.dispatchTool as string,
    entry as unknown as RosterEntry,
  ]),
);

export function getRoster(role: AgentRole): RosterEntry {
  const entry = ROSTER_BY_ROLE.get(role);
  if (!entry) throw new Error(`Unknown role: ${role}`);
  return entry;
}

export function getRosterByDispatchTool(toolName: string): RosterEntry | undefined {
  return ROSTER_BY_DISPATCH_TOOL.get(toolName);
}

export function assertExhaustive(value: never): never {
  throw new Error(`Unhandled roster case: ${String(value)}`);
}

/**
 * Render the "## The Saivage System" role bullet list from the perspective of
 * `forRole`. The focal role's bullet carries the `(you)` marker.
 */
export function renderRosterSummary(forRole: AgentRole): string {
  return ROSTER.map((entry) => {
    const marker = entry.role === forRole ? " (you)" : "";
    return `- **${entry.displayName}**${marker}: ${entry.summary}`;
  }).join("\n");
}
