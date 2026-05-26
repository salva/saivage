import { ref, onMounted, onUnmounted } from "vue";
import {
  WsInboundSchema,
  parseOutbound,
  type WsInbound,
  type WsOutbound,
} from "@channels/ws-schema";
import { withTokenQuery } from "../utils/api";
import { useAuthState } from "./useAuthState";

export type WsStatus = "connecting" | "open" | "closed";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_FACTOR = 1.7;
const ERRORS_CAP = 8;

/**
 * WebSocket composable with:
 *   - bearer-token auth via ?token= (browser WS API can't set headers)
 *   - exponential backoff with jitter on reconnect
 *
 * Auth state lives in {@link useAuthState}: when the server closes with an
 * auth-policy code (1008 / 4401 / 4403) the composable calls
 * `markUnauthorized()` instead of looping; recovery is driven externally
 * by `setApiToken`, which calls `requestRetry()` to fan out to every
 * registered handler.
 *
 * The `connected` ref is kept for backwards compatibility; new code
 * should read `status` for finer-grained UX states.
 */
export function useWebSocket(url?: string) {
  const connected = ref(false);
  const status = ref<WsStatus>("connecting");
  const errors = ref<{ raw: string; reason: string }[]>([]);
  const handlers = new Set<(ev: WsOutbound) => void>();
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let nextBackoffMs = INITIAL_BACKOFF_MS;
  let stopped = false;

  const auth = useAuthState();
  const unsubscribeRetry = auth.onRetry(() => {
    reconnect();
  });

  function getUrl(): string {
    const base = url
      ?? `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
    return withTokenQuery(base);
  }

  function pushError(reason: string, raw: string): void {
    errors.value.push({ raw, reason });
    if (errors.value.length > ERRORS_CAP) {
      errors.value.splice(0, errors.value.length - ERRORS_CAP);
    }
  }

  function emitErrorUpstream(reason: string, raw: string): void {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const truncated = raw.length > 512 ? `${raw.slice(0, 512)}...` : raw;
    ws.send(JSON.stringify({ type: "error", reason, raw: truncated }));
  }

  function connect() {
    if (stopped) return;
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
    status.value = "connecting";

    ws = new WebSocket(getUrl());

    ws.onopen = () => {
      connected.value = true;
      status.value = "open";
      nextBackoffMs = INITIAL_BACKOFF_MS;
    };

    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      const result = parseOutbound(raw);
      if (!result.ok) {
        pushError(result.error, result.raw);
        console.warn("[ws] schema violation from server:", result.error, { raw: result.raw });
        emitErrorUpstream(result.error, result.raw);
        ws?.close();
        return;
      }
      for (const handler of handlers) handler(result.value);
    };

    ws.onclose = (event) => {
      connected.value = false;
      // 1008 (policy violation) and the 4401 custom code we use server-
      // side both indicate an auth failure. Don't loop forever; stop and
      // surface the state so the operator can fix the token.
      if (event.code === 1008 || event.code === 4401 || event.code === 4403) {
        status.value = "closed";
        stopped = true;
        auth.markUnauthorized();
        return;
      }
      status.value = "closed";
      scheduleReconnect();
    };

    ws.onerror = () => {
      // The real recovery path runs in onclose; closing here ensures
      // it always fires.
      ws?.close();
    };
  }

  function send(msg: WsInbound) {
    const parsed = WsInboundSchema.parse(msg);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(parsed));
    }
  }

  function onEvent(handler: (ev: WsOutbound) => void): () => void {
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const jitter = Math.random() * Math.min(500, nextBackoffMs / 2);
    const delay = Math.min(nextBackoffMs + jitter, MAX_BACKOFF_MS);
    nextBackoffMs = Math.min(nextBackoffMs * BACKOFF_FACTOR, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function disconnect() {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.close();
    ws = null;
    connected.value = false;
    status.value = "closed";
    unsubscribeRetry();
  }

  function reconnect() {
    stopped = false;
    nextBackoffMs = INITIAL_BACKOFF_MS;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    connect();
  }

  onMounted(() => connect());
  onUnmounted(() => disconnect());

  return { connected, status, errors, onEvent, send, disconnect, reconnect };
}
