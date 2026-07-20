import { bindingForSession } from "../projects/group-bindings.js";
import type { NotificationChannel } from "./gateway.js";

export type NotificationTargetPlan =
  | { kind: "none" }
  | { kind: "single"; channel: NotificationChannel }
  | { kind: "primary"; channel: NotificationChannel; fallback?: NotificationChannel }
  | { kind: "both" };

export type LarkGroupNotificationTarget = {
  chatId: string;
};

export function boundLarkGroupForSession(
  session: string | undefined,
): LarkGroupNotificationTarget | null {
  if (!session) return null;
  const bound = bindingForSession(session);
  return bound ? { chatId: bound.chatId } : null;
}

export function resolveNotificationTargetPlan(input: {
  registeredChannels: readonly NotificationChannel[];
  session?: string | undefined;
  recentOwnerChannel?: NotificationChannel | undefined;
}): NotificationTargetPlan {
  const channels = [...input.registeredChannels];
  if (channels.length === 0) return { kind: "none" };

  const larkGroup = boundLarkGroupForSession(input.session);
  if (larkGroup && channels.includes("lark")) {
    return primaryWithFallback("lark", channels);
  }

  if (channels.length === 1) {
    const channel = channels[0];
    return channel ? { kind: "single", channel } : { kind: "none" };
  }

  const recent = input.recentOwnerChannel;
  if (recent && channels.includes(recent)) return primaryWithFallback(recent, channels);

  return { kind: "both" };
}

function primaryWithFallback(
  channel: NotificationChannel,
  channels: readonly NotificationChannel[],
): NotificationTargetPlan {
  const fallback = channels.find((candidate) => candidate !== channel);
  return fallback ? { kind: "primary", channel, fallback } : { kind: "single", channel };
}
