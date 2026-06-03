import type { SaivageConfig } from "../../config.js";
import type { ProjectContext } from "../../store/project.js";
import {
  createSecretEnvNamePredicate,
  DEFAULT_CONFIG_POINTER_SUFFIXES,
  DEFAULT_CREDENTIAL_LEXEMES,
} from "../../security/secrets.js";

export interface BuiltinLimits {
  maxOutputBytes: number;
  maxFetchBytes: number;
  maxDownloadBytes: number;
  maxFileReadBytes: number;
  maxSearchResults: number;
  maxSearchDepth: number;
  maxSearchMs: number;
  fetchTimeoutMs: number;
  shellTimeoutFloorMs: number;
  webSearchMaxBytes: number;
  webSearchMaxResults: number;
  webSearchTimeoutMs: number;
  webSearchEndpoint: string;
}

export interface BuiltinSecurityContext {
  isSecretEnvName: (name: string) => boolean;
}

export interface BuiltinContext {
  project: Pick<ProjectContext, "projectRoot">;
  limits: BuiltinLimits;
  security: BuiltinSecurityContext;
}

export function createBuiltinContext(
  mcpConfig: SaivageConfig["mcp"],
  securityConfig: SaivageConfig["security"],
  options: { webSearchEndpoint?: string; project: Pick<ProjectContext, "projectRoot"> },
): BuiltinContext {
  return {
    project: options.project,
    limits: {
      maxOutputBytes: mcpConfig.maxOutputBytes,
      maxFetchBytes: mcpConfig.maxFetchBytes,
      maxDownloadBytes: mcpConfig.maxDownloadBytes,
      maxFileReadBytes: mcpConfig.maxFileReadBytes,
      maxSearchResults: mcpConfig.maxSearchResults,
      maxSearchDepth: mcpConfig.maxSearchDepth,
      maxSearchMs: mcpConfig.maxSearchMs,
      fetchTimeoutMs: mcpConfig.fetchTimeoutMs,
      shellTimeoutFloorMs: mcpConfig.shellTimeoutFloorMs,
      webSearchMaxBytes: mcpConfig.webSearchMaxBytes,
      webSearchMaxResults: mcpConfig.webSearchMaxResults,
      webSearchTimeoutMs: mcpConfig.webSearchTimeoutMs,
      webSearchEndpoint: options.webSearchEndpoint ?? "https://duckduckgo.com/html/",
    },
    security: {
      isSecretEnvName: createSecretEnvNamePredicate({
        credentialLexemes: securityConfig.envScrubber.credentialLexemes,
        configPointerSuffixes: securityConfig.envScrubber.configPointerSuffixes,
      }),
    },
  };
}

export const DEFAULT_BUILTIN_SECURITY_CONTEXT: BuiltinSecurityContext = {
  isSecretEnvName: createSecretEnvNamePredicate({
    credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
    configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
  }),
};

export function filterShellEnv(
  env: NodeJS.ProcessEnv,
  security: BuiltinSecurityContext = DEFAULT_BUILTIN_SECURITY_CONTEXT,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (security.isSecretEnvName(key)) continue;
    result[key] = value;
  }
  return result;
}
