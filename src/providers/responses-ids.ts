import { createHash } from "node:crypto";

const RESPONSES_ITEM_ID_LIMIT = 64;

export function responsesFunctionCallItemId(toolCallId: string): string {
  const prefix = "fc_";
  const sanitized = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_");
  const maxBodyLength = RESPONSES_ITEM_ID_LIMIT - prefix.length;

  if (sanitized.length <= maxBodyLength) return `${prefix}${sanitized}`;

  const digest = createHash("sha256").update(toolCallId).digest("hex").slice(0, 16);
  const headLength = maxBodyLength - digest.length - 1;
  return `${prefix}${sanitized.slice(0, headLength)}_${digest}`;
}