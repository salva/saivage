/**
 * OAuth credential types and provider interface.
 * Mirrors the pi-ai/OpenClaw pattern.
 */

export interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
}

export interface OAuthAuthInfo {
  url: string;
  instructions?: string;
}

export interface OAuthPrompt {
  message: string;
  placeholder?: string;
}

export interface OAuthLoginCallbacks {
  onAuth: (info: OAuthAuthInfo) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
}

export interface OAuthProviderOptions {
  headers?: Record<string, string>;
}

export interface OAuthProviderDef {
  readonly id: string;
  readonly name: string;
  login(callbacks: OAuthLoginCallbacks, options?: OAuthProviderOptions): Promise<OAuthCredentials>;
  refreshToken(credentials: OAuthCredentials, options?: OAuthProviderOptions): Promise<OAuthCredentials>;
  getApiKey(credentials: OAuthCredentials): string;
}

export interface AuthProfile {
  type: "oauth";
  provider: string;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
}

export interface AuthProfileStore {
  version: number;
  profiles: Record<string, AuthProfile>;
}
