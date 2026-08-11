import type { Channel, PersistedMessage, QueuedMessage } from "./queue.js";

export type RestorePersistedChannelSummary = {
  restored: number;
  carriedOver: number;
  skipped: number;
};

export type PersistedChannelRestoreDeps = {
  loadPersisted(): PersistedMessage[];
  enqueue(message: QueuedMessage): "queued" | "duplicate" | false;
  keepPersistedCarryover(messages: PersistedMessage[]): void;
};

export type PersistedChannelRestoreResult = QueuedMessage | "discard" | null;

export function restorePersistedChannel(input: {
  channel: Channel;
  loadPersisted: PersistedChannelRestoreDeps["loadPersisted"];
  enqueue: PersistedChannelRestoreDeps["enqueue"];
  keepPersistedCarryover: PersistedChannelRestoreDeps["keepPersistedCarryover"];
  restore: (message: PersistedMessage) => PersistedChannelRestoreResult;
}): RestorePersistedChannelSummary {
  let restored = 0;
  let skipped = 0;
  const carryover: PersistedMessage[] = [];
  const persistedMessages = input.loadPersisted();
  if (persistedMessages.length === 0) return { restored, carriedOver: 0, skipped };

  for (const persisted of persistedMessages) {
    if ((persisted.channel ?? "telegram") !== input.channel) {
      carryover.push(persisted);
      continue;
    }
    if (persisted.dispatched === true) {
      skipped++;
      continue;
    }
    const message = input.restore(persisted);
    if (message === "discard") {
      skipped++;
      continue;
    }
    if (message === null) {
      skipped++;
      carryover.push(persisted);
      continue;
    }
    const verdict = input.enqueue(message);
    if (verdict !== "queued") {
      carryover.push(persisted);
      continue;
    }
    restored++;
  }

  input.keepPersistedCarryover(carryover);
  return { restored, carriedOver: carryover.length, skipped };
}
