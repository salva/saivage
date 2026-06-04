import type { WorkerInitMeta } from "./roster.js";

export const workerInitTemplates = {
  coder: {
    heading: "Task Assignment",
    extraInstructionLines: [],
    notesDir: null,
    followUpInstruction: null,
    promptKey: "coder",
    invalidFinalResponseMessage:
      "Invalid final task response: you have not used any tools for this task yet.",
  },
  researcher: {
    heading: "Research Task Assignment",
    extraInstructionLines: ["Write findings under: research/"],
    notesDir: null,
    followUpInstruction: null,
    promptKey: "researcher",
    invalidFinalResponseMessage:
      "Invalid final task response: you have not used any tools for this research task yet.",
  },
  data_agent: {
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
  reviewer: {
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
  designer: {
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
  critic: {
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
} as const satisfies Record<string, WorkerInitMeta>;
