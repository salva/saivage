/**
 * Saivage \u2014 F29: typed accessors for pi-ai's model registry.
 *
 * pi-ai's `getModel` / `getModels` are declared with a strict
 * `KnownProvider` generic so the upstream catalogue stays type-checked.
 * Saivage routes model strings that originate at runtime, so we widen the
 * provider parameter to `string` here \u2014 these two `as unknown as`
 * casts are the only ones permitted in the pi-ai integration after F29.
 */

import { getModel, getModels } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";

export const piGetModel = getModel as unknown as (
  provider: string,
  modelId: string,
) => Model<Api> | undefined;

export const piGetModels = getModels as unknown as (
  provider: string,
) => Model<Api>[];

/** Thrown when a model id cannot be resolved against the pi-ai registry. */
export class UnknownModelError extends Error {
  readonly kind = "unknown_model" as const;
  readonly piProvider: string;
  readonly modelId: string;

  constructor(piProvider: string, modelId: string, available: string[]) {
    const sample = available.slice(0, 5).join(", ");
    const more = available.length > 5 ? `, \u2026 (${available.length - 5} more)` : "";
    super(
      `Model "${modelId}" not found for provider "${piProvider}". ` +
        `Available: ${sample}${more}`,
    );
    this.name = "UnknownModelError";
    this.piProvider = piProvider;
    this.modelId = modelId;
  }
}
