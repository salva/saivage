/**
 * Chat channel abstraction — transports that send/receive messages
 * between a Chat agent and a user.
 */
export interface ChatChannel {
  /** Send a message to the user */
  send(message: string): void | Promise<void>;

  /** Register handler for incoming user messages */
  onMessage(handler: (message: string) => void | Promise<void>): void;

  /** Register handler for disconnection */
  onClose(handler: () => void): void;

  /** Close the channel */
  close(): void | Promise<void>;
}
