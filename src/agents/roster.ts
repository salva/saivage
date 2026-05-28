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
import type { RolePromptName } from "./prompt-keys.js";

export type ToolFilterKind =
  | "planner"
  | "worker"
  | "reviewer"
  | "inspector"
  | "chat"
  | "librarian";

/**
 * Per-role metadata used by `WorkerAgent.createWorker` and `buildInitialMessage`
 * to render the initial task message. Worker entries (`worker: true`) populate
 * this; non-worker entries set it to `null`.
 */
export interface WorkerInitMeta {
  heading: string;
  extraInstructionLines: readonly string[];
  notesDir: ((stageId: string) => string) | null;
  followUpInstruction: string | null;
  promptKey: RolePromptName;
  invalidFinalResponseMessage: string;
}

export interface RosterEntry {
  /** Canonical role identifier used throughout the codebase. */
  role: string;
  /** Whether this role is a stage-scoped worker (assignable via TaskSchema). */
  worker: boolean;
  /**
   * Whether the worker instance is reused across follow-up dispatches within
   * the same stage. Stage-scoped workers (reviewer, designer, critic) keep
   * their conversation history so each subsequent task builds on prior turns;
   * non-stage-scoped workers (coder, researcher, data_agent) get a fresh
   * instance per task. Only meaningful when `worker === true`.
   */
  stageScoped: boolean;
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
  /** Worker-only initial-message metadata; null for non-worker roles. */
  workerInit: WorkerInitMeta | null;
}

export const ROSTER = [
  {
    role: "planner",
    worker: false,
    stageScoped: false,
    dispatchTool: null,
    dispatchableBy: [],
    toolFilter: "planner",
    abortPriority: null,
    selfCheckFrequency: 30,
    convention: {
      writeTerritory: [".saivage/plan.json"],
      excludeTerritory: ["src/", "research/"],
      description: "Planner manages plan state via Plan MCP only",
    },
    defaultModelKey: "orchestrator",
    displayName: "Planner",
    summary:
      "The top-level strategist. Owns the project plan — a sequence of stages — and drives the project from its current state to its declared objectives. Long-lived; thinks in stages, not code.",
    workerInit: null,
  },
  {
    role: "manager",
    worker: false,
    stageScoped: false,
    dispatchTool: "run_manager",
    dispatchableBy: ["planner"],
    toolFilter: "worker",
    abortPriority: 7,
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
    workerInit: null,
  },
  {
    role: "coder",
    worker: true,
    stageScoped: false,
    dispatchTool: "run_coder",
    dispatchableBy: ["manager"],
    toolFilter: "worker",
    abortPriority: 4,
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
    workerInit: {
      heading: "Task Assignment",
      extraInstructionLines: [],
      notesDir: null,
      followUpInstruction: null,
      promptKey: "coder",
      invalidFinalResponseMessage:
        "Invalid final task response: you have not used any tools for this task yet.",
    },
  },
  {
    role: "researcher",
    worker: true,
    stageScoped: false,
    dispatchTool: "run_researcher",
    dispatchableBy: ["manager"],
    toolFilter: "worker",
    abortPriority: 5,
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
    workerInit: {
      heading: "Research Task Assignment",
      extraInstructionLines: ["Write findings under: research/"],
      notesDir: null,
      followUpInstruction: null,
      promptKey: "researcher",
      invalidFinalResponseMessage:
        "Invalid final task response: you have not used any tools for this research task yet.",
    },
  },
  {
    role: "data_agent",
    worker: true,
    stageScoped: false,
    dispatchTool: "run_data_agent",
    dispatchableBy: ["manager"],
    toolFilter: "worker",
    abortPriority: 3,
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
    workerInit: {
      heading: "Data Acquisition Task Assignment",
      extraInstructionLines: [
        "Write downloaded artifacts to the project-relative path that best fits the task; data/ is common but not mandatory.",
        "Write provenance notes under research/data-sources/ or another clearly named research/provenance path.",
        "Use retries, fallback source URLs, alternate access methods, and an attempt manifest when downloads are unreliable.",
      ],
      notesDir: null,
      followUpInstruction: null,
      promptKey: "data-agent",
      invalidFinalResponseMessage:
        "Invalid final task response: you have not used any tools for this data task yet.",
    },
  },
  {
    role: "reviewer",
    worker: true,
    stageScoped: true,
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
    workerInit: {
      heading: "Stage Review Task Assignment",
      extraInstructionLines: [
        "Review the stage objectives, expected outcomes, acceptance criteria, task list, worker reports, changed artifacts, and any existing summary drafts.",
        "For data-heavy or ML/research stages, validate data provenance/suitability, leakage controls, statistical acceptance, benchmark comparison, and whether conclusions are supported.",
      ],
      notesDir: (stageId: string) => `.saivage/stages/${stageId}/reviews/`,
      followUpInstruction:
        "This is a follow-up review in the same stage-scoped reviewer session. Your previous reports and reasoning are above in this conversation. Focus first on the new corrective-task results, then verify whether earlier issues are resolved or still open.",
      promptKey: "reviewer",
      invalidFinalResponseMessage:
        "Invalid final review response: you have not used any tools to inspect evidence yet.",
    },
  },
  {
    role: "designer",
    worker: true,
    stageScoped: true,
    dispatchTool: "run_designer",
    dispatchableBy: ["manager"],
    toolFilter: "worker",
    abortPriority: 6,
    selfCheckFrequency: 15,
    convention: {
      writeTerritory: ["research/design/", "docs/", ".saivage/stages/"],
      excludeTerritory: ["src/"],
      description:
        "Designer writes design briefs, UX/product notes, and architecture design docs, not production code",
    },
    defaultModelKey: "designer",
    displayName: "Designer",
    summary:
      "A one-shot design agent. Produces product, UX, interface, information-architecture, and system-design artifacts that make ambiguous implementation work concrete before coding starts. Returns a `TaskReport`.",
    workerInit: {
      heading: "Design Task Assignment",
      extraInstructionLines: [
        "Produce design artifacts that are concrete enough for implementation and review.",
      ],
      notesDir: (stageId: string) => `.saivage/stages/${stageId}/design-notes/`,
      followUpInstruction:
        "This is a follow-up design turn in the same stage-scoped designer session. Your prior design artifacts and reasoning are above in this conversation. Build on them: extend or revise, do not start over. If this turn responds to critique, address each issue explicitly.",
      promptKey: "designer",
      invalidFinalResponseMessage:
        "Invalid final design response: you have not used any tools for this design task yet.",
    },
  },
  {
    role: "critic",
    worker: true,
    stageScoped: true,
    dispatchTool: "run_critic",
    dispatchableBy: ["manager"],
    toolFilter: "reviewer",
    abortPriority: 2,
    selfCheckFrequency: 15,
    convention: {
      writeTerritory: [
        "research/design/critiques/",
        "docs/critiques/",
        ".saivage/stages/",
      ],
      excludeTerritory: ["src/", "data/", "research/data-sources/"],
      description:
        "Critic writes critique documents reviewing design artifacts, not implementation, data, or new design artifacts",
    },
    defaultModelKey: "critic",
    displayName: "Critic",
    summary:
      "A one-shot reviewer of design documents. Reads specs, briefs, and architecture docs produced by the Designer, writes a standalone critique document, and returns a `TaskReport` with actionable issues. Does not review code, tests, or data — that is the Reviewer.",
    workerInit: {
      heading: "Design Critique Task Assignment",
      extraInstructionLines: [
        "Read the design artifacts named in the task and any referenced source/docs needed to judge them in context.",
        "Write a standalone critique document at the project-relative path that best fits the artifact under review (e.g. research/design/critiques/<artifact-id>.md, docs/critiques/<artifact-id>.md, or .saivage/stages/<stage-id>/critiques/<task-id>.md).",
        "Do not rewrite the design yourself; tell the Designer what to fix via issues_found[] and the critique document.",
      ],
      notesDir: (stageId: string) => `.saivage/stages/${stageId}/critiques/`,
      followUpInstruction:
        "This is a follow-up critique turn in the same stage-scoped critic session. Your previous critique documents and reasoning are above in this conversation. Focus first on whether the Designer addressed your previous issues, then look for new problems introduced by the revisions.",
      promptKey: "critic",
      invalidFinalResponseMessage:
        "Invalid final critique response: you have not used any tools to inspect the design artifacts yet.",
    },
  },
  {
    role: "inspector",
    worker: false,
    stageScoped: false,
    dispatchTool: "run_inspector",
    dispatchableBy: ["planner"],
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
    workerInit: null,
  },
  {
    role: "chat",
    worker: false,
    stageScoped: false,
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
      "The user-facing surface. Answers user questions about project state, relays user direction and investigation requests to the Planner via notes, and pushes notifications about significant events. Does not write project files or dispatch workers.",
    workerInit: null,
  },
  {
    role: "librarian",
    worker: false,
    stageScoped: false,
    dispatchTool: "run_librarian",
    dispatchableBy: ["planner", "manager"],
    toolFilter: "librarian",
    abortPriority: 8,
    selfCheckFrequency: 20,
    convention: {
      writeTerritory: [".saivage/memory/project/"],
      excludeTerritory: ["src/", "research/"],
      description: "Librarian curates project-scoped rag memories only.",
    },
    defaultModelKey: "orchestrator",
    displayName: "Librarian",
    summary:
      "Curates the RAG knowledge surface. Investigates retrieval gaps and drift, " +
      "records policies and incident memories under topic.domain='rag', does not " +
      "write skills or non-rag memories.",
    workerInit: null,
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

export function getAbortPriority(role: AgentRole): number | null {
  return getRoster(role).abortPriority;
}

export function getToolFilter(role: AgentRole): ToolFilterKind {
  return getRoster(role).toolFilter;
}

export function getDispatchToolsFor(parent: AgentRole): string[] {
  return ROSTER
    .filter((e) => e.dispatchTool !== null && (e.dispatchableBy as readonly string[]).includes(parent))
    .map((e) => e.dispatchTool as string);
}

export function isConcurrencyLimitedDispatch(role: DispatchableRole): boolean {
  return getRoster(role).worker;
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

/**
 * Worker-only accessor for the initial-message metadata. Throws if `role` is
 * a worker on `ROSTER` but `workerInit` was forgotten (cannot happen given the
 * compile-time anchor below, but documents intent at the runtime boundary).
 */
export function getWorkerInitMeta(role: WorkerRole): WorkerInitMeta {
  const meta = getRoster(role).workerInit;
  if (meta === null) {
    throw new Error(`Roster entry for "${role}" has no workerInit metadata`);
  }
  return meta;
}

// Compile-time guard: every entry with worker: true must have a non-null
// workerInit. Wrapped-tuple form prevents the bare `extends never`
// distribution over the union.
type _WorkerEntriesWithNullInit = Extract<
  (typeof ROSTER)[number],
  { worker: true; workerInit: null }
>;
type _EveryWorkerHasInit = [_WorkerEntriesWithNullInit] extends [never] ? true : never;
const _everyWorkerHasInit: _EveryWorkerHasInit = true;
void _everyWorkerHasInit;
