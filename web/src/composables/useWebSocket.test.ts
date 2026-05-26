// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h } from "vue";

import { useWebSocket } from "./useWebSocket";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly CONNECTING = MockWebSocket.CONNECTING;
  readonly OPEN = MockWebSocket.OPEN;
  readonly CLOSED = MockWebSocket.CLOSED;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls: unknown[][] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(...args: unknown[]): void {
    this.closeCalls.push(args);
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: args[0] ?? 1005 } as CloseEvent);
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  simulateMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const sockets: MockWebSocket[] = [];
const realWebSocket = globalThis.WebSocket;

function mountComposable() {
  const state: { api?: ReturnType<typeof useWebSocket> } = {};
  const app = createApp(defineComponent({
    setup() {
      state.api = useWebSocket("ws://test");
      return () => h("div");
    },
  }));
  const host = document.createElement("div");
  document.body.appendChild(host);
  app.mount(host);
  if (!state.api) throw new Error("composable did not mount");
  return {
    api: state.api,
    socket: sockets.at(-1) ?? (() => { throw new Error("no socket"); })(),
    unmount: () => {
      app.unmount();
      host.remove();
    },
  };
}

describe("useWebSocket", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sockets.length = 0;
    globalThis.WebSocket = realWebSocket;
    document.body.innerHTML = "";
  });

  it("emits parsed outbound server events to registered handlers", () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const { api, socket, unmount } = mountComposable();
    const seen: unknown[] = [];
    api.onEvent((event) => { seen.push(event); });

    socket.simulateOpen();
    socket.simulateMessage(JSON.stringify({ type: "message", content: "hi" }));

    expect(seen).toEqual([{ type: "message", content: "hi" }]);
    unmount();
  });

  it("records malformed server frames, sends error upstream, and closes without args", () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { api, socket, unmount } = mountComposable();

    socket.simulateOpen();
    socket.simulateMessage("not-json");

    expect(api.errors.value.at(-1)).toMatchObject({ raw: "not-json" });
    expect(socket.sent.at(-1)).toMatch(/^\{"type":"error","reason":/);
    expect(socket.closeCalls.at(-1)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      "[ws] schema violation from server:",
      expect.any(String),
      { raw: "not-json" },
    );
    unmount();
  });

  it("does not expose the old events array", () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const { api, unmount } = mountComposable();

    expect("events" in api).toBe(false);
    unmount();
  });

  it("send validates at runtime and writes nothing for drifting payloads", () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const { api, socket, unmount } = mountComposable();

    socket.simulateOpen();
    expect(() => api.send({ type: "toolCall" } as any)).toThrow();
    expect(socket.sent).toHaveLength(0);
    unmount();
  });

  it("send writes valid inbound envelopes", () => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const { api, socket, unmount } = mountComposable();

    socket.simulateOpen();
    api.send({ type: "message", content: "hi" });

    expect(socket.sent.at(-1)).toBe('{"type":"message","content":"hi"}');
    unmount();
  });
});
