import * as readline from "node:readline";
import type { ChatChannel } from "./types.js";

/**
 * CLI-based chat channel using stdin/stdout.
 */
export class CLIChannel implements ChatChannel {
  private rl: readline.Interface;
  private messageHandler: ((message: string) => void | Promise<void>) | null = null;
  private closeHandler: (() => void) | null = null;
  private closed = false;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "",
    });

    this.rl.on("line", (line) => {
      if (this.closed) return;
      const trimmed = line.trim();
      if (trimmed && this.messageHandler) {
        this.messageHandler(trimmed);
      }
    });

    this.rl.on("close", () => {
      this.closed = true;
      this.closeHandler?.();
    });
  }

  send(message: string): void {
    if (this.closed) return;
    process.stdout.write(message + "\n");
  }

  onMessage(handler: (message: string) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.closed = true;
    this.rl.close();
  }

  /** Show the prompt marker */
  prompt(): void {
    process.stdout.write("\n> ");
  }
}
