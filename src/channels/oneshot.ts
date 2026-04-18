import type { ChatChannel } from "./types.js";

/**
 * One-shot channel — sends a single message and collects the response.
 */
export class OneShotChannel implements ChatChannel {
  private messageHandler: ((message: string) => void | Promise<void>) | null = null;
  private doneHandler: (() => void | Promise<void>) | null = null;
  private sent = false;

  constructor(private readonly message: string) {}

  send(message: string): void {
    if (!this.sent) {
      this.sent = true;
    }
    process.stdout.write(message + "\n");

    // After receiving the response, signal done
    if (this.sent) {
      setTimeout(() => this.doneHandler?.(), 50);
    }
  }

  onMessage(handler: (message: string) => void | Promise<void>): void {
    this.messageHandler = handler;
    // Immediately send the one-shot message
    setTimeout(() => handler(this.message), 0);
  }

  onClose(_handler: () => void): void {
    // No-op — we control lifecycle via onDone
  }

  close(): void {
    // No-op
  }

  /** Register a handler for when the response has been sent */
  onDone(handler: () => void | Promise<void>): void {
    this.doneHandler = handler;
  }
}
