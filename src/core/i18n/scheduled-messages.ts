import { type ScheduleMessages, scheduledMessageCatalogs } from "./catalog/scheduled-messages.js";
import { resolveUiLang } from "./index.js";

export function scheduleMessages(channel: "telegram" | "lark" | "control"): ScheduleMessages {
  return scheduledMessageCatalogs[channel === "control" ? "en" : resolveUiLang(channel)];
}

/** Render the wall time in the recorded zone, independently of the host zone. */
export function formatScheduledTime(dueAt: number, timezone: string, locale: string): string {
  const offset = /^UTC([+-])(\d{2}):(\d{2})$/.exec(timezone);
  let timestamp = dueAt;
  let zone = timezone;
  if (offset) {
    const minutes = Number(offset[2]) * 60 + Number(offset[3]);
    timestamp += (offset[1] === "+" ? minutes : -minutes) * 60_000;
    zone = "UTC";
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: zone,
  }).format(timestamp);
}
