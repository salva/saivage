import { z } from "zod";

export const WsInboundSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    content: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal("error"),
    reason: z.string().min(1),
    raw: z.string().optional(),
  }).strict(),
]);
export type WsInbound = z.infer<typeof WsInboundSchema>;

export const WsOutboundSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session"),
    sessionId: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal("thinking"),
  }).strict(),
  z.object({
    type: z.literal("message"),
    content: z.string(),
    provider: z.string().optional(),
    model: z.string().optional(),
    modelSpec: z.string().optional(),
    requestedModelSpec: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("system"),
    content: z.string(),
  }).strict(),
  z.object({
    type: z.literal("event"),
    content: z.string().optional(),
    summary: z.string().optional(),
    stage_id: z.string().optional(),
    task_id: z.string().optional(),
    report_id: z.string().optional(),
  }).strict(),
]);
export type WsOutbound = z.infer<typeof WsOutboundSchema>;

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; raw: string };

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

export function parseInbound(raw: string): ParseResult<WsInbound> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `invalid-json: ${message}`, raw };
  }

  const result = WsInboundSchema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: formatZodError(result.error), raw };
}

export function parseOutbound(raw: string): ParseResult<WsOutbound> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `invalid-json: ${message}`, raw };
  }

  const result = WsOutboundSchema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: formatZodError(result.error), raw };
}
