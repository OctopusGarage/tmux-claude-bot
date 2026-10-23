import type { QueuedMessage } from "../command/queue-message.js";
export type ScheduleOwner = {
  channel: "telegram" | "lark" | "control";
  chatId: string;
  userId: string;
};
export type ScheduledTarget = {
  sessionName: string;
  label: string;
  workspacePath: string | null;
  incarnation: string;
};
export type ScheduledMessageRecord = {
  id: string;
  owner: ScheduleOwner;
  target: ScheduledTarget;
  text: string;
  dueAt: number;
  timezone: string;
  createdAt: number;
  updatedAt: number;
  status:
    | "scheduled"
    | "queued"
    | "sending"
    | "sent"
    | "blocked"
    | "failed"
    | "cancelled"
    | "uncertain";
  sentAt?: number | undefined;
  error?: string | undefined;
  result?: string | undefined;
  requestId: string;
  prepared?:
    | Pick<QueuedMessage, "text" | "origin" | "promptSource" | "sourceText" | "transform">
    | undefined;
  retryAt?: number | undefined;
  attempts?: number | undefined;
};
export type ScheduleEvent = {
  kind: "sent" | "result" | "error" | "blocked" | "uncertain";
  text: string;
};
export function sameOwner(a: ScheduleOwner, b: ScheduleOwner): boolean {
  return a.channel === b.channel && a.chatId === b.chatId && a.userId === b.userId;
}
