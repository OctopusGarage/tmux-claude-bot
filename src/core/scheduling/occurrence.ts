export type Schedule =
  | { kind: "now" }
  | { kind: "at"; at: number }
  | { kind: "cron"; cron: string };

function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const match = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!match) return null;
    const step = match[3] ? Number(match[3]) : 1;
    const low = match[1] === "*" ? min : Number(match[1]);
    let high = match[2] !== undefined ? Number(match[2]) : match[1] === "*" ? max : low;
    if (match[3] && match[2] === undefined) high = max;
    if (
      Number.isNaN(low) ||
      Number.isNaN(high) ||
      low < min ||
      high > max ||
      low > high ||
      step < 1
    ) {
      return null;
    }
    for (let value = low; value <= high; value += step) out.add(value);
  }
  return out;
}

/** Return the next UTC minute matched by a five-field cron, strictly after `after`. */
export function nextCronFire(expression: string, after: number): number | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = [
    parseField(parts[0] as string, 0, 59),
    parseField(parts[1] as string, 0, 23),
    parseField(parts[2] as string, 1, 31),
    parseField(parts[3] as string, 1, 12),
    parseField(parts[4] as string, 0, 6),
  ];
  if (fields.some((field) => field === null)) return null;
  const [minutes, hours, days, months, weekdays] = fields as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  const start = new Date(Math.ceil((after + 1) / 60_000) * 60_000);
  const limit = after + 366 * 24 * 60 * 60 * 1_000;
  for (let time = start.getTime(); time <= limit; time += 60_000) {
    const date = new Date(time);
    if (
      minutes.has(date.getUTCMinutes()) &&
      hours.has(date.getUTCHours()) &&
      months.has(date.getUTCMonth() + 1) &&
      days.has(date.getUTCDate()) &&
      weekdays.has(date.getUTCDay())
    ) {
      return time;
    }
  }
  return null;
}

export function nextFire(schedule: Schedule, after: number): number | null {
  if (schedule.kind === "now") return after;
  if (schedule.kind === "at") return schedule.at > after ? schedule.at : null;
  return nextCronFire(schedule.cron, after);
}
