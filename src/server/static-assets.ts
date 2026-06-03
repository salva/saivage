import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { pathExists } from "../store/documents.js";
import { log } from "../log.js";

export async function registerStaticAssets(app: FastifyInstance): Promise<void> {
  const thisDir = import.meta.dirname ?? __dirname;
  const webDistPath = thisDir.includes("/src/")
    ? join(thisDir, "..", "..", "web", "dist")
    : join(thisDir, "..", "web", "dist");
  await app.register(fastifyStatic, {
    root: webDistPath,
    prefix: "/",
    wildcard: true,
  });

  const docsDistPath = thisDir.includes("/src/")
    ? join(thisDir, "..", "..", "docs", ".vitepress", "dist")
    : join(thisDir, "..", "docs", ".vitepress", "dist");
  if (await pathExists(docsDistPath)) {
    await app.register(fastifyStatic, {
      root: docsDistPath,
      prefix: "/docs/",
      decorateReply: false,
      wildcard: true,
      index: ["index.html"],
    });
    log.info(`[server] docs mounted at /docs/ from ${docsDistPath}`);
  } else {
    log.info("[server] docs not built (run 'npm run docs:build') - /docs/ disabled");
    app.get("/docs/", async (_req, reply) => {
      reply.type("text/html").send(
        "<!doctype html><meta charset=\"utf-8\"><title>Saivage docs</title>" +
        "<style>body{font:14px/1.5 system-ui;margin:3rem auto;max-width:38rem;color:#222}</style>" +
        "<h1>Documentation not built</h1>" +
        "<p>Run <code>npm run docs:build</code> in the project root, then reload this page.</p>",
      );
    });
  }
}
