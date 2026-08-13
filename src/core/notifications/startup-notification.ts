import type { NotificationGateway } from "./gateway.js";

/** Deliver one concise recovery alert through a preferred owner route. */
export async function notifyCrashRecovery(
  notifications: NotificationGateway,
  crashIdentity: string | null,
): Promise<void> {
  if (crashIdentity === null || process.env.TCB_STARTUP_NOTIFY === "0") return;
  const channels = notifications.registeredChannels();
  const preferred = channels.includes("telegram") ? "telegram" : channels[0];
  if (preferred === undefined) return;
  const request = {
    level: "warning" as const,
    source: "tmux-claude-bot" as const,
    title: "Service recovered",
    body: "Recovered after an unclean exit",
    delivery: {
      mode: "once-per-window" as const,
      topic: "service:crash-recovery",
      window: crashIdentity,
    },
  };
  const primary = await notifications.notify({ ...request, channel: preferred });
  if (primary.status !== "failed") return;
  const fallback = channels.find((channel) => channel !== preferred);
  if (fallback !== undefined) await notifications.notify({ ...request, channel: fallback });
}
