/**
 * OpenAI Codex (ChatGPT Plus/Pro) OAuth flow.
 *
 * Uses PKCE + authorization_code grant with a local callback server.
 * Same flow as OpenClaw/pi-ai.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderDef } from "./types.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

function createState(): string {
  return randomBytes(16).toString("hex");
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1]!));
  } catch {
    return null;
  }
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch { /* not a URL */ }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}

async function exchangeCode(
  code: string,
  verifier: string,
): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const json = (await response.json()) as Record<string, unknown>;
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("Token response missing required fields");
  }

  return {
    access: json.access_token as string,
    refresh: json.refresh_token as string,
    expires: Date.now() + (json.expires_in as number) * 1000,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  const json = (await response.json()) as Record<string, unknown>;
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("Token refresh response missing required fields");
  }

  return {
    access: json.access_token as string,
    refresh: json.refresh_token as string,
    expires: Date.now() + (json.expires_in as number) * 1000,
  };
}

function startCallbackServer(
  expectedState: string,
): Promise<{ close: () => void; waitForCode: () => Promise<string | null> }> {
  return new Promise((resolve) => {
    let settleCode: ((code: string | null) => void) | undefined;
    const codePromise = new Promise<string | null>((res) => {
      settleCode = res;
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "", "http://localhost");

      if (url.pathname !== "/auth/callback") {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<h1>Not found</h1>");
        return;
      }

      if (url.searchParams.get("state") !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>State mismatch</h1>");
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Missing authorization code</h1>");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Authentication complete — you can close this window.</h1>");
      settleCode?.(code);
    });

    server
      .listen(CALLBACK_PORT, "127.0.0.1", () => {
        resolve({
          close: () => server.close(),
          waitForCode: () => codePromise,
        });
      })
      .on("error", () => {
        settleCode?.(null);
        resolve({
          close: () => { try { server.close(); } catch { /* ignore */ } },
          waitForCode: async () => null,
        });
      });
  });
}

export async function loginOpenAICodex(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const { verifier, challenge } = await generatePKCE();
  const state = createState();

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "saivage");

  const server = await startCallbackServer(state);
  callbacks.onAuth({
    url: url.toString(),
    instructions: "A browser window should open. Complete login to finish.",
  });

  let code: string | undefined;
  try {
    const result = await server.waitForCode();
    if (result) {
      code = result;
    }

    if (!code) {
      const input = await callbacks.onPrompt({
        message: "Paste the authorization code (or full redirect URL):",
      });
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) {
        throw new Error("State mismatch");
      }
      code = parsed.code;
    }

    if (!code) {
      throw new Error("Missing authorization code");
    }

    const creds = await exchangeCode(code, verifier);

    const payload = decodeJwt(creds.access);
    const auth = payload?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
    if (auth?.chatgpt_account_id) {
      creds.accountId = auth.chatgpt_account_id as string;
    }

    return creds;
  } finally {
    server.close();
  }
}

export async function refreshOpenAICodexToken(
  refreshToken: string,
): Promise<OAuthCredentials> {
  const creds = await refreshAccessToken(refreshToken);

  const payload = decodeJwt(creds.access);
  const auth = payload?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
  if (auth?.chatgpt_account_id) {
    creds.accountId = auth.chatgpt_account_id as string;
  }

  return creds;
}

export const openaiCodexOAuthProvider: OAuthProviderDef = {
  id: "openai-codex",
  name: "ChatGPT Plus/Pro (Codex)",
  async login(callbacks) {
    return loginOpenAICodex(callbacks);
  },
  async refreshToken(credentials) {
    return refreshOpenAICodexToken(credentials.refresh);
  },
  getApiKey(credentials) {
    return credentials.access;
  },
};
