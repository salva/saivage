/**
 * Pure stage-id-to-topic resolution against a generic repo-layout contract.
 *
 * The function is intentionally side-effect-free and has no project-specific
 * vocabulary. Behaviour:
 *
 *  - exactly one matching topic and ``new_stages_allowed`` true ->
 *    ``{ topic, reason: null }``
 *  - zero matching topics -> ``{ topic: null, reason: "no_topic_match" }``
 *  - more than one matching topic -> ``{ topic: null,
 *    reason: "multiple_topic_match", matches: [...] }``
 *  - exactly one matching topic but ``new_stages_allowed`` false ->
 *    ``{ topic: null, reason: "topic_closed", matches: [<topic>] }``
 */

import type { Contract } from "./contract.js";

export type StageIdReason =
  | "no_topic_match"
  | "multiple_topic_match"
  | "topic_closed";

export interface StageIdValidation {
  readonly topic: string | null;
  readonly reason: StageIdReason | null;
  readonly matches: ReadonlyArray<string>;
}

export function validateStageId(contract: Contract, stageId: string): StageIdValidation {
  const matches = contract.topics.filter((t) => t.stageIdRe.test(stageId));

  if (matches.length === 0) {
    return Object.freeze({ topic: null, reason: "no_topic_match" as const, matches: Object.freeze([]) });
  }

  if (matches.length > 1) {
    return Object.freeze({
      topic: null,
      reason: "multiple_topic_match" as const,
      matches: Object.freeze(matches.map((t) => t.name)),
    });
  }

  const only = matches[0]!;
  if (!only.newStagesAllowed) {
    return Object.freeze({
      topic: null,
      reason: "topic_closed" as const,
      matches: Object.freeze([only.name]),
    });
  }

  return Object.freeze({
    topic: only.name,
    reason: null,
    matches: Object.freeze([only.name]),
  });
}
