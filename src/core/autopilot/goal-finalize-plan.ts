import { advanceCycle } from "./goals/goal-state.js";
import type { AutopilotNotice } from "./notifier.js";
import type { Action, AutopilotState } from "./types.js";

export type BetweenGoalsMode = "compact" | "clear" | "none";

export type GoalFinalizePlan =
  | {
      kind: "advance";
      state: AutopilotState;
      action: Action;
      notice: AutopilotNotice & { kind: "goalAdvance" };
      fromGoalId: string;
      contextOp: BetweenGoalsMode;
    }
  | {
      kind: "done";
      state: AutopilotState;
      action: Action;
      notice:
        | (AutopilotNotice & { kind: "complete" })
        | (AutopilotNotice & { kind: "cycleComplete" });
      isCycle: boolean;
    };

export function planGoalFinalize(input: {
  session: string;
  goalId: string;
  nextState: AutopilotState;
  reason: string;
  betweenGoals: BetweenGoalsMode;
}): GoalFinalizePlan {
  const step = advanceCycle(input.nextState);
  if (step.kind === "next") {
    const state =
      input.betweenGoals === "none"
        ? step.state
        : { ...step.state, pendingContextOp: input.betweenGoals };
    return {
      kind: "advance",
      state,
      action: { kind: "none" },
      notice: {
        kind: "goalAdvance",
        session: input.session,
        goalId: step.state.goalId ?? "",
        pos: (step.state.queuePos ?? 0) + 1,
        total: step.state.goalQueue?.length ?? 1,
        round: (step.state.roundsDone ?? 0) + 1,
        rounds: step.state.rounds ?? 1,
      },
      fromGoalId: input.goalId,
      contextOp: state.pendingContextOp ?? "none",
    };
  }

  const isCycle = (input.nextState.goalQueue?.length ?? 1) > 1 || (input.nextState.rounds ?? 1) > 1;
  return {
    kind: "done",
    state: { ...input.nextState, enabled: false },
    action: { kind: "pauseNotify", reason: input.reason },
    notice: isCycle
      ? { kind: "cycleComplete", session: input.session, rounds: input.nextState.rounds ?? 1 }
      : { kind: "complete", session: input.session, goalId: input.goalId },
    isCycle,
  };
}
