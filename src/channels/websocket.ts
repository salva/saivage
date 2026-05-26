import type { WebSocket } from "ws";
import type { ChatChannel } from "./types.js";
import { parseInbound, WsOutboundSchema, type WsOutbound } from "./ws-schema.js";
import { log } from "../log.js";

/**
 * WebSocket-based chat channel for the web UI.
 */
export class WebSocketChannel implements ChatChannel {
  private messageHandler: ((message: string) => void | Promise<void>) | null = null;
  private closeHandler: (() => void) | null = null;

  constructor(private ws: WebSocket) {
    ws.on("message", (data) => {
      const result = parseInbound(data.toString());
      if (!result.ok) {
        log.warn(`[ws] dropping malformed inbound frame: ${result.error}`);
        this.ws.close(1003, "schema-violation");
        return;
      }
      if (result.value.type === "message") {
        this.messageHandler?.(result.value.content);
        return;
      }
      log.warn(
        `[ws] client reported schema violation: ${result.value.reason}` +
          (result.value.raw ? ` (raw=${result.value.raw})` : ""),
      );
    });

    ws.on("close", () => {
      this.closeHandler?.();
    });
  }

  send(message: string): void {
    this.sendEvent({ type: "message", content: message });
  }

  sendEvent(event: WsOutbound): void {
    const parsed = WsOutboundSchema.parse(event);
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(parsed));
    }
  }

  onMessage(handler: (message: string) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.ws.close();
  }
}
