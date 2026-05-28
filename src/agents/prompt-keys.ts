/**
 * Saivage — Role Prompt Names
 *
 * Type-only module declaring the union of prompt file names under prompts/.
 * Lives apart from both `prompts.ts` and `roster.ts` to break what would
 * otherwise be a cyclic import (roster.ts <-> prompts.ts).
 */

export type RolePromptName =
  | "planner"
  | "manager"
  | "coder"
  | "researcher"
  | "data-agent"
  | "reviewer"
  | "designer"
  | "critic"
  | "inspector"
  | "chat"
  | "librarian";
