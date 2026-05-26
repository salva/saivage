/**
 * GitHub Copilot OAuth flow (device code grant).
 *
 * Unlike OpenAI Codex / Anthropic which use PKCE + authorization_code,
 * GitHub Copilot uses the device code flow:
 *   1. Request a device code + user code
 *   2. User opens verification URL and enters the user code
 *   3. Poll for access token
 *   4. Exchange GitHub token for a Copilot API token
 *
 * Mirrors the pi-ai/OpenClaw implementation.
 */
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderDef, OAuthProviderOptions } from "./types.js";
import { loadConfig } from "../config.js";
import { resolveCopilotHeaders } from "../providers/copilot-client-headers.js";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

function getUrls(domain: string) {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
    copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
  };
}

/**
 * Parse the proxy-ep from a Copilot token and derive the API base URL.
 * Token format: tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...
 */
export function getBaseUrlFromToken(token: string): string | null {
  const match = token.match(/proxy-ep=([^;]+)/);
  if (!match) return null;
  const proxyHost = match[1]!;
  const apiHost = proxyHost.replace(/^proxy\./, "api.");
  return `https://${apiHost}`;
}

export function getGitHubCopilotBaseUrl(
  token: string | null,
  enterpriseDomain?: string,
): string {
  if (token) {
    const url = getBaseUrlFromToken(token);
    if (url) return url;
  }
  if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
  return "https://api.individual.githubcopilot.com";
}

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

async function startDeviceFlow(domain: string, headers: Record<string, string>): Promise<DeviceCodeResponse> {
  const clientId = (await loadConfig()).oauth.githubCopilot.clientId;
  const urls = getUrls(domain);
  const data = await fetchJson(urls.deviceCodeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": headers["User-Agent"]!,
    },
    body: new URLSearchParams({
      client_id: clientId,
      scope: "read:user",
    }),
  });

  const deviceCode = data.device_code;
  const userCode = data.user_code;
  const verificationUri = data.verification_uri;
  const interval = data.interval;
  const expiresIn = data.expires_in;

  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    typeof interval !== "number" ||
    typeof expiresIn !== "number"
  ) {
    throw new Error("Invalid device code response");
  }

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    interval,
    expires_in: expiresIn,
  };
}

async function pollForAccessToken(
  domain: string,
  deviceCode: string,
  intervalSeconds: number,
  expiresIn: number,
  headers: Record<string, string>,
): Promise<string> {
  const clientId = (await loadConfig()).oauth.githubCopilot.clientId;
  const urls = getUrls(domain);
  const deadline = Date.now() + expiresIn * 1000;
  let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));
  let intervalMultiplier = 1.2;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const waitMs = Math.min(Math.ceil(intervalMs * intervalMultiplier), remainingMs);
    await new Promise((r) => setTimeout(r, waitMs));

    const raw = await fetchJson(urls.accessTokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": headers["User-Agent"]!,
      },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (typeof raw.access_token === "string") {
      return raw.access_token;
    }

    if (typeof raw.error === "string") {
      if (raw.error === "authorization_pending") continue;
      if (raw.error === "slow_down") {
        intervalMs =
          typeof raw.interval === "number" && (raw.interval as number) > 0
            ? (raw.interval as number) * 1000
            : Math.max(1000, intervalMs + 5000);
        intervalMultiplier = 1.4;
        continue;
      }
      throw new Error(`Device flow failed: ${raw.error}`);
    }
  }

  throw new Error("Device flow timed out");
}

/**
 * Exchange a GitHub access token for a Copilot API token.
 * The GitHub token is effectively the "refresh" token. The Copilot token
 * is short-lived and used for API calls.
 */
export async function refreshGitHubCopilotToken(
  githubToken: string,
  options: { enterpriseDomain?: string; headers?: Record<string, string> } = {},
): Promise<OAuthCredentials> {
  const domain = options.enterpriseDomain || "github.com";
  const urls = getUrls(domain);
  const headers = resolveCopilotHeaders(options.headers);

  const raw = await fetchJson(urls.copilotTokenUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${githubToken}`,
      ...headers,
    },
  });

  const token = raw.token;
  const expiresAt = raw.expires_at;

  if (typeof token !== "string" || typeof expiresAt !== "number") {
    throw new Error("Invalid Copilot token response");
  }

  return {
    refresh: githubToken,
    access: token,
    // Expire 5 min early to be safe
    expires: expiresAt * 1000 - 5 * 60 * 1000,
  };
}

export async function loginGitHubCopilot(
  callbacks: OAuthLoginCallbacks,
  options: { headers?: Record<string, string> } = {},
): Promise<OAuthCredentials> {
  // For now, always use github.com (no enterprise prompt)
  const domain = "github.com";
  const headers = resolveCopilotHeaders(options.headers);

  const device = await startDeviceFlow(domain, headers);

  callbacks.onAuth({
    url: device.verification_uri,
    instructions: `Enter code: ${device.user_code}`,
  });

  callbacks.onProgress?.("Waiting for authorization...");

  const githubAccessToken = await pollForAccessToken(
    domain,
    device.device_code,
    device.interval,
    device.expires_in,
    headers,
  );

  callbacks.onProgress?.("Exchanging for Copilot token...");

  const credentials = await refreshGitHubCopilotToken(githubAccessToken, { headers: options.headers });
  return credentials;
}

export const githubCopilotOAuthProvider: OAuthProviderDef = {
  id: "github-copilot",
  name: "GitHub Copilot",

  async login(callbacks, options?: OAuthProviderOptions) {
    return loginGitHubCopilot(callbacks, options ?? {});
  },

  async refreshToken(credentials, options?: OAuthProviderOptions) {
    return refreshGitHubCopilotToken(credentials.refresh, { headers: options?.headers });
  },

  getApiKey(credentials) {
    return credentials.access;
  },
};
