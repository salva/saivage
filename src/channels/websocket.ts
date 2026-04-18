import type { WebSocket } from "ws";
import type { ChatChannel } from "./types.js";

export interface WsEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * WebSocket-based chat channel for the web UI.
 */
export class WebSocketChannel implements ChatChannel {
  private messageHandler: ((message: string) => void | Promise<void>) | null = null;
  private closeHandler: (() => void) | null = null;

  constructor(private ws: WebSocket) {
    ws.on("message", (data) => {
      const msg = data.toString().trim();
      if (msg && this.messageHandler) {
        this.messageHandler(msg);
      }
    });

    ws.on("close", () => {
      this.closeHandler?.();
    });
  }

  send(message: string): void {
    this.sendEvent({ type: "message", content: message });
  }

  /** Send a typed event to the client */
  sendEvent(event: WsEvent): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(event));
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
