export function parseScheduleTime(
  when: string,
  now = Date.now(),
): { dueAt: number; timezone: string } {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const relative = /^(\d+)(m|h|d)$/.exec(when);
  if (relative) {
    const amount = Number(relative[1]);
    const dueAt =
      now + amount * { m: 60000, h: 3600000, d: 86400000 }[relative[2] as "m" | "h" | "d"];
    if (!Number.isSafeInteger(dueAt) || amount <= 0) throw new Error("Invalid duration");
    return { dueAt, timezone };
  }
  const clock = /^(\d{2}):(\d{2})$/.exec(when);
  if (clock) {
    const hour = Number(clock[1]),
      minute = Number(clock[2]);
    if (hour > 23 || minute > 59) throw new Error("Invalid time");
    const date = new Date(now);
    date.setHours(hour, minute, 0, 0);
    if (date.getTime() <= now) date.setDate(date.getDate() + 1);
    if (date.getHours() !== hour || date.getMinutes() !== minute)
      throw new Error("Nonexistent local time: use an explicit offset");
    for (const delta of [-7200000, -3600000, -1800000, 1800000, 3600000, 7200000]) {
      const other = new Date(date.getTime() + delta);
      if (
        other.getFullYear() === date.getFullYear() &&
        other.getMonth() === date.getMonth() &&
        other.getDate() === date.getDate() &&
        other.getHours() === hour &&
        other.getMinutes() === minute
      )
        throw new Error("Ambiguous local time: use an explicit offset");
    }
    return { dueAt: date.getTime(), timezone };
  }
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      when,
    );
  if (!iso) throw new Error("Use a duration, HH:mm, or an ISO timestamp with an explicit offset");
  const [, y, mo, d, h, mi, s = "0", offset] = iso;
  const calendar = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (
    calendar.getUTCFullYear() !== Number(y) ||
    calendar.getUTCMonth() !== Number(mo) - 1 ||
    calendar.getUTCDate() !== Number(d) ||
    Number(h) > 23 ||
    Number(mi) > 59 ||
    Number(s) > 59 ||
    (offset !== "Z" && (Number(offset?.slice(1, 3)) > 23 || Number(offset?.slice(4)) > 59))
  )
    throw new Error("Invalid timestamp");
  const dueAt = Date.parse(when);
  if (!Number.isFinite(dueAt) || dueAt <= now)
    throw new Error("Scheduled time must be in the future");
  return { dueAt, timezone: offset === "Z" ? "UTC" : `UTC${offset}` };
}
