import type { AutopilotState } from "../types.js";

export function startGoalState(prev: AutopilotState, goalId: string): AutopilotState {
  return {
    ...prev,
    enabled: true,
    optOut: false, // starting a goal is an explicit engage — clear any prior `/autopilot off` opt-out
    goalId,
    phaseIndex: 0,
    seqIndex: 0,
    goalIterations: 0,
    humanGatePending: false,
    humanConfirmed: false,
    reworkPending: false, // a fresh goal starts clean (the flag is one-shot, but don't carry a stray)
    startedAt: Date.now(),
    iterations: 0,
    apiRetries: 0,
    recoveries: 0,
  };
}

export function advancePhaseState(prev: AutopilotState): AutopilotState {
  return {
    ...prev,
    phaseIndex: (prev.phaseIndex ?? 0) + 1,
    seqIndex: 0,
    humanGatePending: false,
    humanConfirmed: false,
  };
}

/** Begin a goal cycle: a queue of goals run `rounds` times. The active goal is
 * goalQueue[queuePos]; `goalId` mirrors it so existing readers keep working. */
export function startCycleState(
  prev: AutopilotState,
  goalIds: string[],
  rounds: number,
): AutopilotState {
  return {
    ...startGoalState(prev, goalIds[0] ?? ""),
    goalQueue: goalIds,
    rounds,
    queuePos: 0,
    roundsDone: 0,
  };
}

export type CycleStep = { kind: "next"; state: AutopilotState } | { kind: "done" };

/** Called when the active goal finalizes. Advances to the next goal in the queue,
 * or wraps to the next round, or reports the whole cycle is done. Pure. */
export function advanceCycle(prev: AutopilotState): CycleStep {
  const queue = prev.goalQueue ?? (prev.goalId ? [prev.goalId] : []);
  const rounds = prev.rounds ?? 1;
  const pos = prev.queuePos ?? 0;
  const roundsDone = prev.roundsDone ?? 0;
  if (pos + 1 < queue.length) {
    return { kind: "next", state: resetForGoal(prev, queue, pos + 1, roundsDone) };
  }
  if (roundsDone + 1 >= rounds) return { kind: "done" };
  return { kind: "next", state: resetForGoal(prev, queue, 0, roundsDone + 1) };
}

function resetForGoal(
  prev: AutopilotState,
  queue: string[],
  pos: number,
  roundsDone: number,
): AutopilotState {
  return {
    ...prev,
    goalQueue: queue,
    queuePos: pos,
    roundsDone,
    goalId: queue[pos]!,
    phaseIndex: 0,
    seqIndex: 0,
    humanGatePending: false,
    humanConfirmed: false,
    goalIterations: 0,
  };
}
