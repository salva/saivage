/**
 * API token + fetch helper.
 *
 * The Saivage server can be configured to require a bearer token
 * (via SAIVAGE_API_TOKEN) on /api/* and /ws. The SPA needs a way to
 * supply that token. Resolution order:
 *
 *   1. Query string ?token=... on first load — once read, the value
 *      is moved to localStorage and stripped from the URL so it is
 *      not bookmarked or copied around.
 *   2. localStorage["saivage.apiToken"].
 *   3. (none) — fetches and WebSocket connections proceed without auth,
 *      which is the correct behaviour for unsecured private deployments.
 */

const STORAGE_KEY = "saivage.apiToken";

let cachedToken: string | null | undefined;

function readFromQuery(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (!token) return null;
  // Strip the token from the URL so it doesn't end up in browser
  // history / bookmarks.
  params.delete("token");
  const search = params.toString();
  const newUrl = window.location.pathname + (search ? `?${search}` : "") + window.location.hash;
  window.history.replaceState({}, document.title, newUrl);
  return token;
}

function readFromStorage(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getApiToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  const fromQuery = readFromQuery();
  if (fromQuery) {
    try {
      window.localStorage.setItem(STORAGE_KEY, fromQuery);
    } catch {
      // localStorage may be disabled (private browsing); fall through
      // and keep the token in memory only.
    }
    cachedToken = fromQuery;
    return cachedToken;
  }
  cachedToken = readFromStorage();
  return cachedToken;
}

export function setApiToken(token: string | null): void {
  cachedToken = token;
  if (typeof window === "undefined") return;
  try {
    if (token) window.localStorage.setItem(STORAGE_KEY, token);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore — value remains cached in memory
  }
}

/**
 * Append the API token (if any) as ?token=... to a same-origin URL.
 * Used for WebSocket connections, which cannot carry custom headers.
 */
export function withTokenQuery(urlOrPath: string): string {
  const token = getApiToken();
  if (!token) return urlOrPath;
  const sep = urlOrPath.includes("?") ? "&" : "?";
  return `${urlOrPath}${sep}token=${encodeURIComponent(token)}`;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly url: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiFetchOptions extends RequestInit {
  /** When true, swallow non-OK responses and return them as-is instead of throwing. */
  allowNonOk?: boolean;
}

/**
 * Fetch wrapper that:
 *  - injects the API token via Authorization: Bearer when set,
 *  - throws ApiError on non-2xx responses by default (so callers'
 *    catch blocks actually see failures instead of stale spinners),
 *  - logs every failure to the console with the URL.
 *
 * Pass `{ allowNonOk: true }` to opt out of throwing on non-OK; the
 * raw Response is returned and the caller is responsible for inspecting
 * `.ok` / `.status`.
 */
export async function apiFetch(input: string, init: ApiFetchOptions = {}): Promise<Response> {
  const { allowNonOk, headers, ...rest } = init;
  const token = getApiToken();
  const finalHeaders = new Headers(headers ?? {});
  if (token && !finalHeaders.has("Authorization")) {
    finalHeaders.set("Authorization", `Bearer ${token}`);
  }
  let response: Response;
  try {
    response = await fetch(input, { ...rest, headers: finalHeaders });
  } catch (err) {
    console.error(`[saivage] fetch ${input} failed:`, err);
    throw err;
  }
  if (!response.ok && !allowNonOk) {
    const message = `${response.status} ${response.statusText}`;
    console.error(`[saivage] fetch ${input} -> ${message}`);
    throw new ApiError(response.status, input, message);
  }
  return response;
}

/** Fetch + JSON parse, with the same error semantics as apiFetch. */
export async function apiFetchJson<T = unknown>(input: string, init?: ApiFetchOptions): Promise<T> {
  const response = await apiFetch(input, init);
  return (await response.json()) as T;
}
