/**
 * Saivage — Self-Check
 * Inject progress-assessment prompt every N tool-call rounds.
 * Stuck detection via context limits + max compactions.
 */

import type { AgentRole } from "../agents/types.js";
import { ROSTER } from "../agents/roster.js";

/** Default self-check frequencies per agent role. */
export const DEFAULT_SELF_CHECK_FREQUENCY: Record<AgentRole, number> = Object.fromEntries(
  ROSTER.map((entry) => [entry.role, entry.selfCheckFrequency]),
) as Record<AgentRole, number>;

/** Self-check state per agent conversation. */
export interface SelfCheckState {
  /** Number of tool-call rounds since last self-check. */
  roundsSinceCheck: number;
  /** Configured frequency (N rounds between checks). */
  frequency: number;
}

/** Create initial self-check state for an agent. */
export function createSelfCheckState(
  role: AgentRole,
  configFrequency?: number,
): SelfCheckState {
  return {
    roundsSinceCheck: 0,
    frequency: configFrequency ?? DEFAULT_SELF_CHECK_FREQUENCY[role],
  };
}

/** Record that a tool-call round was completed. Returns true if a self-check should fire. */
export function recordToolCallRound(state: SelfCheckState): boolean {
  if (state.frequency <= 0) return false;

  state.roundsSinceCheck++;
  if (state.roundsSinceCheck >= state.frequency) {
    state.roundsSinceCheck = 0;
    return true;
  }
  return false;
}

/** The self-check message injected into the conversation. */
export function selfCheckMessage(frequency: number): string {
  return (
    `Self-check: You have completed ${frequency} tool-call rounds. ` +
    `Briefly assess: are you making progress toward the objective, or are you stuck in a loop? ` +
    `If stuck, finish with a failure result. If making progress, continue.`
  );
}
