export type LoopSupervisorResetMode = "none" | "compact" | "clear";

export type LoopSupervisorBatchItem<T> = {
  item: T;
  supervisorSession: string;
};

export function allocateLoopSupervisorBatches<T extends { projectPath: string }>(
  items: readonly T[],
  supervisorSessions: readonly string[],
): Array<Array<LoopSupervisorBatchItem<T>>> {
  if (items.length === 0) return [];
  if (supervisorSessions.length === 0) {
    return items.map((item) => [{ item, supervisorSession: "unconfigured-loop-supervisor" }]);
  }

  const pending = items.map((item, index) => ({ item, index }));
  const batches: Array<Array<LoopSupervisorBatchItem<T>>> = [];

  while (pending.length > 0) {
    const usedPaths = new Set<string>();
    const selectedIndexes = new Set<number>();
    const batch: Array<LoopSupervisorBatchItem<T>> = [];

    for (const candidate of pending) {
      if (batch.length >= supervisorSessions.length) break;
      if (usedPaths.has(candidate.item.projectPath)) continue;
      const supervisorSession = supervisorSessions[batch.length];
      if (supervisorSession === undefined) break;
      usedPaths.add(candidate.item.projectPath);
      selectedIndexes.add(candidate.index);
      batch.push({ item: candidate.item, supervisorSession });
    }

    batches.push(batch);
    for (let idx = pending.length - 1; idx >= 0; idx--) {
      if (selectedIndexes.has(pending[idx]?.index ?? -1)) pending.splice(idx, 1);
    }
  }

  return batches;
}
