/**
 * F02 B06 — `rag` MCP handler. Builds the seven-tool surface and
 * dispatches per-tool implementations with role / mutex / envelope
 * wrapping. The bootstrap (B07) constructs a `RagService` and wires
 * this handler through `registerBuiltinServices`.
 */
import { z } from "zod";
import {
  isRuntimeOperatorContext,
  requiresAdminRole,
  requiresControlMutex,
  type RagService,
} from "./service.js";
import { ragOk, ragErr } from "./envelope.js";
import { mapRagError } from "./errors.js";
import { tryRunExclusive } from "./mutex.js";
import { ragList } from "./tools/list.js";
import { ragStats } from "./tools/stats.js";
import { ragQuery } from "./tools/query.js";
import { ragRegister } from "./tools/register.js";
import { ragIngest } from "./tools/ingest.js";
import { ragDrop } from "./tools/drop.js";
import { ragAdmin } from "./tools/admin.js";
import type { InProcessToolHandler } from "./../../mcp/runtime.js";
import type { ToolEntry } from "./../../mcp/types.js";
import type { ToolCallContext } from "../../mcp/toolContext.js";
import { log } from "../../log.js";

const queryFilterSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ eq: z.record(z.string(), z.union([z.string(), z.number(), z.null()])) }),
    z.object({ and: z.array(queryFilterSchema) }),
    z.object({ or: z.array(queryFilterSchema) }),
    z.object({
      gt: z.record(z.string(), z.number()),
      lt: z.record(z.string(), z.number()).optional(),
    }),
    z.object({ pathGlob: z.string() }),
    z.object({ in: z.record(z.string(), z.array(z.union([z.string(), z.number()]))) }),
  ]),
);

const chunkerSchema = z.object({
  kind: z.enum(["markdown", "code", "memory"]),
  chunkSize: z.number().int().positive().optional(),
  overlap: z.number().min(0).max(0.5).optional(),
});

const watchSchema = z.union([
  z.literal(false),
  z.literal(true),
  z.object({ usePolling: z.literal(true), interval: z.number().int().positive().optional() }),
]);

const sourcesSchema = z.array(
  z.object({
    root: z.string().min(1),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  }),
);

type RagToolRegistryEntry = {
  schema: z.ZodType;
  definition: ToolEntry;
  impl(service: RagService, args: unknown, ctx: ToolCallContext): Promise<unknown>;
};

const RAG_TOOL_REGISTRY = {
  rag_list: {
    schema: z.object({}).strict(),
    definition: {
      name: "rag_list",
      description: "List registered RAG collections.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    impl: async (svc) => ragList(svc),
  },
  rag_stats: {
    schema: z.object({ collection_id: z.string().min(1) }).strict(),
    definition: {
      name: "rag_stats",
      description: "Read stats for a collection.",
      inputSchema: {
        type: "object",
        properties: { collection_id: { type: "string" } },
        required: ["collection_id"],
      },
    },
    impl: async (svc, args) => ragStats(svc, args as Parameters<typeof ragStats>[1]),
  },
  rag_query: {
    schema: z
      .object({
        collection_id: z.string().min(1),
        text: z.string().min(1),
        topK: z.number().int().positive().max(100).optional(),
        filter: queryFilterSchema.optional(),
      })
      .strict(),
    definition: {
      name: "rag_query",
      description: "Semantic search a collection.",
      inputSchema: {
        type: "object",
        properties: {
          collection_id: { type: "string" },
          text: { type: "string" },
          topK: { type: "number" },
          filter: { type: "object" },
        },
        required: ["collection_id", "text"],
      },
    },
    impl: async (svc, args) => ragQuery(svc, args as Parameters<typeof ragQuery>[1]),
  },
  rag_register: {
    schema: z
      .object({
        collection_id: z.string().min(1),
        source: z.enum(["doc", "code"]),
        provider: z
          .object({
            model: z.string().min(1).optional(),
            dim: z.number().int().positive().optional(),
          })
          .optional(),
        chunker: chunkerSchema,
        exclusions: z.array(z.string()).optional(),
        sources: sourcesSchema,
        watch: watchSchema.optional(),
        persist: z.boolean().optional(),
      })
      .strict(),
    definition: {
      name: "rag_register",
      description: "Register a new RAG collection (admin-only).",
      inputSchema: {
        type: "object",
        properties: {
          collection_id: { type: "string" },
          source: { type: "string", enum: ["doc", "code"] },
          chunker: { type: "object" },
          sources: { type: "array" },
          provider: {
            type: "object",
            properties: {
              model: { type: "string", minLength: 1 },
              dim: { type: "integer", minimum: 1 },
            },
          },
          exclusions: { type: "array" },
          watch: {},
          persist: { type: "boolean" },
        },
        required: ["collection_id", "source", "chunker", "sources"],
      },
    },
    impl: async (svc, args) => ragRegister(svc, args as Parameters<typeof ragRegister>[1]),
  },
  rag_ingest: {
    schema: z.object({ collection_id: z.string().min(1) }).strict(),
    definition: {
      name: "rag_ingest",
      description: "Ingest into a registered collection (admin-only).",
      inputSchema: {
        type: "object",
        properties: { collection_id: { type: "string" } },
        required: ["collection_id"],
      },
    },
    impl: async (svc, args) => ragIngest(svc, args as Parameters<typeof ragIngest>[1]),
  },
  rag_drop: {
    schema: z.object({ collection_id: z.string().min(1), persist: z.boolean().optional() }).strict(),
    definition: {
      name: "rag_drop",
      description: "Drop a registered collection (admin-only).",
      inputSchema: {
        type: "object",
        properties: { collection_id: { type: "string" }, persist: { type: "boolean" } },
        required: ["collection_id"],
      },
    },
    impl: async (svc, args) => ragDrop(svc, args as Parameters<typeof ragDrop>[1]),
  },
  rag_admin: {
    schema: z
      .object({
        collection_id: z.string().min(1),
        action: z.enum(["reconcile", "watch_arm", "watch_disarm"]),
      })
      .strict(),
    definition: {
      name: "rag_admin",
      description: "Control-plane actions on a collection (admin-only).",
      inputSchema: {
        type: "object",
        properties: {
          collection_id: { type: "string" },
          action: { type: "string", enum: ["reconcile", "watch_arm", "watch_disarm"] },
        },
        required: ["collection_id", "action"],
      },
    },
    impl: async (svc, args) => ragAdmin(svc, args as Parameters<typeof ragAdmin>[1]),
  },
} as const satisfies Record<string, RagToolRegistryEntry>;

export const RAG_TOOL_DEFINITIONS: ToolEntry[] = Object.values(RAG_TOOL_REGISTRY).map((tool) => tool.definition);

/**
 * Build the in-process MCP handler for the `rag` service. Returns the
 * canonical `{ content, isError }` envelope used by `McpRuntime`.
 */
export function makeRagHandler(service: RagService): InProcessToolHandler {
  return async (toolName, args, ctx) => {
    const role = ctx?.role ?? "unknown";
    log.info(
      "rag.call " + JSON.stringify({ tool: toolName, role, agentId: ctx?.agentId ?? null }),
    );

    if (!service.enabled) {
      return wrap(ragErr("RAG_DISABLED", "rag is disabled"));
    }

    if (!ctx) {
      return wrap(ragErr("RAG_UNAUTHORIZED_ROLE", "missing ToolCallContext"));
    }

    if (
      requiresAdminRole(toolName) &&
      !isRuntimeOperatorContext(ctx) &&
      !service.adminRoles.has(ctx.role)
    ) {
      return wrap(ragErr("RAG_UNAUTHORIZED_ROLE", `role=${ctx.role} cannot ${toolName}`));
    }

    const tool = (RAG_TOOL_REGISTRY as Record<string, RagToolRegistryEntry | undefined>)[toolName];
    if (!tool) {
      return wrap(ragErr("RAG_INTERNAL", `unknown tool ${toolName}`));
    }
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      return wrap(
        ragErr("RAG_INVALID_ARGS", parsed.error.message, { issues: parsed.error.issues }),
      );
    }

    try {
      if (requiresControlMutex(toolName)) {
        const slot = tryRunExclusive(service.control, () => tool.impl(service, parsed.data, ctx));
        if (!slot.ok) {
          return wrap(ragErr("RAG_CONTROL_BUSY", "another control operation is in progress"));
        }
        return wrap(await unwrapResult(slot.value));
      }
      return wrap(await unwrapResult(tool.impl(service, parsed.data, ctx)));
    } catch (err) {
      const m = mapRagError(err);
      return wrap(ragErr(m.code, m.message, m.details));
    }
  };
}

async function unwrapResult(p: Promise<unknown>): Promise<unknown> {
  const v = await p;
  // Tool implementations may return a `RagErrEnvelope` (pre-mapped); pass
  // it straight through. Otherwise wrap as `ragOk`.
  if (
    v !== null &&
    typeof v === "object" &&
    (v as { ok?: unknown }).ok === false &&
    typeof (v as { code?: unknown }).code === "string"
  ) {
    return v;
  }
  return ragOk(v);
}

function wrap(envelope: unknown): { content: unknown; isError: boolean } {
  const isError =
    envelope !== null &&
    typeof envelope === "object" &&
    (envelope as { ok?: unknown }).ok === false;
  return { content: envelope, isError };
}
