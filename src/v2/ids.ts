/**
 * Saivage v2 — ID generator
 * nanoid-based with entity prefixes: stg-, tsk-, note-, insp-, chat-
 */

import { randomUUID } from "node:crypto";

const ID_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 12;

/** Generate a random ID using crypto, base36-encoded to the given length. */
function generateId(length: number = ID_LENGTH): string {
  // Use randomUUID and strip hyphens, take first `length` chars as base
  const raw = randomUUID().replace(/-/g, "");
  let result = "";
  for (let i = 0; i < length; i++) {
    const byte = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
    result += ID_ALPHABET[byte % ID_ALPHABET.length];
  }
  return result;
}

/** Prefixed ID generators for each entity type. */
export function stageId(): string {
  return `stg-${generateId()}`;
}

export function taskId(): string {
  return `tsk-${generateId()}`;
}

export function noteId(): string {
  return `note-${generateId()}`;
}

export function inspectionId(): string {
  return `insp-${generateId()}`;
}

export function chatSessionId(): string {
  return `chat-${generateId()}`;
}

export function agentId(): string {
  return `agent-${generateId()}`;
}
