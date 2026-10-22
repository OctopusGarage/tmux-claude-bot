import * as fs from "node:fs";
import { join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";

type NotificationChannel = "telegram" | "lark";

const SCHEMA_VERSION = 1;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_RECORDS = 500;

type NotificationPolicyRecord = {
  topic: string;
  fingerprint: string;
  channel: NotificationChannel;
  deliveredAt: number;
};

type NotificationPolicyState = {
  schemaVersion: 1;
  records: NotificationPolicyRecord[];
};

type NotificationPolicyStoreOptions = {
  stateDir?: string;
  now?: () => number;
};

export class NotificationPolicyStore {
  private readonly path: string;
  private readonly now: () => number;

  constructor(options: NotificationPolicyStoreOptions = {}) {
    this.path = join(options.stateDir ?? appStateDir(), "notification-policy.json");
    this.now = options.now ?? Date.now;
  }

  shouldDeliver(
    topic: string,
    fingerprint: string,
    channel: NotificationChannel,
    notifyInitial: boolean,
  ): boolean {
    const now = this.now();
    const previous = this.read().records.find(
      (record) =>
        record.topic === topic &&
        record.channel === channel &&
        now - record.deliveredAt <= RETENTION_MS,
    );
    if (previous === undefined) return notifyInitial;
    return previous.fingerprint !== fingerprint;
  }

  recordDelivered(topic: string, fingerprint: string, channel: NotificationChannel): void {
    const deliveredAt = this.now();
    const retained = this.read().records.filter(
      (record) =>
        deliveredAt - record.deliveredAt <= RETENTION_MS &&
        !(record.topic === topic && record.channel === channel),
    );
    retained.push({ topic, fingerprint, channel, deliveredAt });
    const records = retained
      .sort((left, right) => left.deliveredAt - right.deliveredAt)
      .slice(-MAX_RECORDS);
    try {
      writeFileAtomicSync(
        this.path,
        `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, records }, null, 2)}\n`,
        { mode: 0o600 },
      );
    } catch {
      // Delivery remains authoritative. A persistence failure must never hide a
      // future actionable alert; the next call simply fails open again.
    }
  }

  private read(): NotificationPolicyState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.path, "utf8")) as unknown;
      return parseState(parsed) ?? emptyState();
    } catch {
      return emptyState();
    }
  }
}

function emptyState(): NotificationPolicyState {
  return { schemaVersion: SCHEMA_VERSION, records: [] };
}

function parseState(value: unknown): NotificationPolicyState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.schemaVersion !== SCHEMA_VERSION || !Array.isArray(state.records)) return null;
  const records: NotificationPolicyRecord[] = [];
  for (const value of state.records) {
    const record = parseRecord(value);
    if (record === null) return null;
    records.push(record);
  }
  return { schemaVersion: SCHEMA_VERSION, records };
}

function parseRecord(value: unknown): NotificationPolicyRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.topic !== "string" ||
    record.topic.length === 0 ||
    record.topic.length > 200 ||
    typeof record.fingerprint !== "string" ||
    record.fingerprint.length === 0 ||
    record.fingerprint.length > 300 ||
    (record.channel !== "telegram" && record.channel !== "lark") ||
    typeof record.deliveredAt !== "number" ||
    !Number.isFinite(record.deliveredAt)
  ) {
    return null;
  }
  return {
    topic: record.topic,
    fingerprint: record.fingerprint,
    channel: record.channel,
    deliveredAt: record.deliveredAt,
  };
}
