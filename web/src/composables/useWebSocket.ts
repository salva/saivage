import { ref, onMounted, onUnmounted } from "vue";

export interface WsEvent {
  type: string;
  [key: string]: unknown;
}

export function useWebSocket(url?: string) {
  const connected = ref(false);
  const events = ref<WsEvent[]>([]);
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const reconnectDelay = 2000;

  function getUrl(): string {
    if (url) return url;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }

  function connect() {
    if (ws?.readyState === WebSocket.OPEN) return;

    ws = new WebSocket(getUrl());

    ws.onopen = () => {
      connected.value = true;
    };

    ws.onmessage = (event) => {
      try {
        const evt = JSON.parse(event.data) as WsEvent;
        events.value.push(evt);
      } catch {
        events.value.push({ type: "message", content: event.data });
      }
    };

    ws.onclose = () => {
      connected.value = false;
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  function send(content: string) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(content);
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.close();
    ws = null;
    connected.value = false;
  }

  onMounted(() => connect());
  onUnmounted(() => disconnect());

  return { connected, events, send, disconnect };
}
