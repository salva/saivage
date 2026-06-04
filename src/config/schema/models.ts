import { z } from "zod";

export const modelAssignmentSchema = z.union([z.string(), z.array(z.string())]);

export const modelsSchema = z
  .object({
    orchestrator: modelAssignmentSchema.optional(),
    coder: modelAssignmentSchema.optional(),
    researcher: modelAssignmentSchema.optional(),
    data_agent: modelAssignmentSchema.optional(),
    reviewer: modelAssignmentSchema.optional(),
    designer: modelAssignmentSchema.optional(),
    critic: modelAssignmentSchema.optional(),
    chat: modelAssignmentSchema.optional(),
    default: modelAssignmentSchema.optional(),
  })
  .default({});
