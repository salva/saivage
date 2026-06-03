import type { FastifyInstance } from "fastify";
import { log } from "../log.js";

export interface RequestWithAuthBits {
  headers: Record<string, unknown>;
  query?: unknown;
  url?: string;
}

export function extractRequestToken(req: RequestWithAuthBits): string | undefined {
  const headerToken =
    (req.headers["x-saivage-token"] as string | undefined) ??
    bearer(req.headers["authorization"] as string | string[] | undefined);
  const query = req.query as { token?: string } | undefined;
  return headerToken ?? query?.token;
}

export function registerApiTokenAuth(app: FastifyInstance, apiToken: string | undefined): void {
  if (!apiToken) return;

  log.info("[server] API token gate enabled (SAIVAGE_API_TOKEN set)");
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0] ?? "";
    if (!url.startsWith("/api/")) return;
    if (extractRequestToken(req) !== apiToken) {
      return reply.status(401).send({ error: "unauthorized" });
    }
  });
}

function bearer(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  const header = Array.isArray(value) ? value[0] : value;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}
