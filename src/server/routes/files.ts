import type { FastifyInstance } from "fastify";

export interface FileReads {
  list(query: { path?: string; root?: string }): Promise<{ status: number; body: unknown }>;
  read(query: { path?: string; root?: string }): Promise<{ status: number; body: unknown }>;
}

export function registerFilesRoutes(app: FastifyInstance, reads: FileReads): void {
  app.get("/api/files", async (req, reply) => {
    const result = await reads.list(req.query as { path?: string; root?: string });
    return reply.status(result.status).send(result.body);
  });

  app.get("/api/files/content", async (req, reply) => {
    const result = await reads.read(req.query as { path?: string; root?: string });
    return reply.status(result.status).send(result.body);
  });
}
