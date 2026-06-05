export type ChatEvent =
  | { type: "session"; sessionId: string }
  | { type: "thinking" }
  | {
      type: "message";
      content: string;
      provider?: string;
      model?: string;
      modelSpec?: string;
      requestedModelSpec?: string;
    }
  | { type: "system"; content: string }
  | {
      type: "event";
      content?: string;
      summary?: string;
      stage_id?: string;
      task_id?: string;
      report_id?: string;
    };

/**
 * Chat channel abstraction — transports that send/receive messages
 * between a Chat agent and a user.
 */
export interface ChatChannel {
  /** Send a message to the user */
  send(message: string): void | Promise<void>;

  /** Send a structured transport-neutral event to the user. */
  sendEvent(event: ChatEvent): void | Promise<void>;

  /** Register handler for incoming user messages */
  onMessage(handler: (message: string) => void | Promise<void>): void;

  /** Register handler for disconnection */
  onClose(handler: () => void): void;

  /** Close the channel */
  close(): void | Promise<void>;
}
