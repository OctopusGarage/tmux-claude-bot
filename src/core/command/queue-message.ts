import type { Channel as ChatChannel } from "../projects/project-manager.js";

export type Channel = ChatChannel | "control";

export type ControlRestoreMetadata = {
  kind: string;
  [key: string]: unknown;
};

export type QueuedMessage = {
  id: string;
  text: string;
  chatId: string | number;
  channel?: Channel | undefined;
  sessionName?: string | undefined;
  action: string;
  origin?: "user" | "system" | undefined;
  promptSource?: "telegram" | "lark" | "control" | undefined;
  sourceText?: string | undefined;
  transform?:
    | {
        kind: "translation";
        provider: string;
        from: string;
        to: string;
        sourceText: string;
        deliveredText: string;
      }
    | undefined;
  traceId?: string | undefined;
  controlRestore?: ControlRestoreMetadata | undefined;
  resolve: (output: string) => void;
  reject: (err: Error) => void;
  /** Optional interim-progress channel: sends a message to the chat while the
   * run is still in flight (resolve/reject remain the one-shot finale). */
  notify?: ((text: string) => void) | undefined;
  /** Optional total wait horizon for long system-owned tasks. Ordinary chat
   * prompts use the configured global horizon; supervised loop work orders can
   * safely wait longer because they are bounded by their own WorkOrder timeout. */
  maxWaitDoneTotalMs?: number | undefined;
  /** Optional task-specific completion probe. System-owned long tasks can finish
   * by writing durable artifacts before the agent UI becomes idle; when this
   * returns true, the queue resolves with the latest pane output instead of
   * waiting for an idle marker. */
  doneProbe?: ((output: string) => boolean) | undefined;
  /** Optional lifecycle hook fired after the item is dequeued and before the
   * queue handler types into the target session. Used by persisted control work
   * to distinguish queued from already-dispatched WorkOrders across restarts. */
  /** Return false to reject a dequeued item before its handler runs. */
  started?: (() => boolean | undefined) | undefined;
  /** Don't persist this message to the on-disk backlog. For the local control
   * transport (the TUI): its client is ephemeral, so a bot restart must not
   * "restore" a prompt that has no one to reply to. Still fully queued in-memory
   * (per-session serialization holds), just never written to pending.json. */
  ephemeral?: boolean | undefined;
  /** Chat message id (stringified) of this item's "queued" ack, set once the ack
   * is sent (setQueueAck). A reply to that ack rewrites THIS item (rewriteByAck).
   * Persisted, so reply-to-rewrite survives a restart exactly like the item does —
   * the ack mapping lives WITH the item rather than in a separate volatile map. */
  ackMsgId?: string | undefined;
};

export type PersistedMessage = {
  id: string;
  text: string;
  chatId: string | number;
  channel?: Channel | undefined;
  sessionName?: string | undefined;
  action: string;
  origin?: "user" | "system" | undefined;
  promptSource?: "telegram" | "lark" | "control" | undefined;
  sourceText?: string | undefined;
  transform?: QueuedMessage["transform"];
  traceId?: string | undefined;
  controlRestore?: ControlRestoreMetadata | undefined;
  maxWaitDoneTotalMs?: number | undefined;
  ackMsgId?: string | undefined;
  /** True after the queue has dequeued this item and started handing it to the
   * dispatcher. Restored queues must not replay it because text may already have
   * been typed into the agent pane before the process stopped. */
  dispatched?: boolean | undefined;
};
