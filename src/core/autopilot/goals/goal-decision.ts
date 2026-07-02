import type { AgentKind } from "../../../shared/types.js";
import type { CheckRunner } from "../check-runner.js";
import type { AutopilotState, GoalOutcome, SessionSignal } from "../types.js";
import { evaluateDone } from "./done.js";
import { advancePhaseState } from "./goal-state.js";
import { intentToText } from "./intent.js";
import type { Goal } from "./types.js";

export async function decideGoal(
  goal: Goal,
  signal: SessionSignal,
  state: AutopilotState,
  ctx: { agentKind: AgentKind; runCheck: CheckRunner; cwd: string | undefined },
): Promise<GoalOutcome> {
  if (signal.busy || !signal.queueEmpty) return { kind: "none" };

  const phaseIndex = state.phaseIndex ?? 0;
  const phase = goal.phases[phaseIndex];
  if (phase === undefined) {
    return {
      kind: "finalize",
      reason: `All ${goal.phases.length} phase(s) complete`,
      nextState: state,
    };
  }

  // Re-evaluate with the current seqIndex in a loop: a seq condition may advance
  // seqIndex in a single tick (e.g. sentinel satisfied → seq moves to humanGate),
  // so we keep evaluating until we hit a blocking condition or no progress.
  let currentState = state;
  for (;;) {
    const result = await evaluateDone(phase.done, {
      sentinels: signal.sentinels,
      runCheck: ctx.runCheck,
      cwd: ctx.cwd,
      humanConfirmed: currentState.humanConfirmed ?? false,
      seqIndex: currentState.seqIndex ?? 0,
    });

    if (result.satisfied) {
      const isLastPhase = phaseIndex >= goal.phases.length - 1;
      if (isLastPhase) {
        return {
          kind: "finalize",
          reason: `Goal "${goal.id}" complete`,
          nextState: currentState,
        };
      }
      return { kind: "advance", nextState: advancePhaseState(currentState) };
    }

    if (result.pendingHumanGate) {
      if (!currentState.humanGatePending) {
        return {
          kind: "awaitHuman",
          reason: `Phase "${phase.id}" requires human confirmation`,
          nextState: { ...currentState, humanGatePending: true },
        };
      }
      return { kind: "none" };
    }

    // A gating check is still in flight (its first run hasn't returned). The agent
    // has already emitted its done sentinel, so do NOT re-inject the phase prompt —
    // that re-prompts a finished agent on every detectCheck-gated goal. Wait one
    // tick for the cached result; a real failure (ok:false, not pending) still
    // falls through to inject below and keeps the agent working.
    if (result.pendingCheck) return { kind: "none" };

    // If seqIndex advanced (seq step satisfied, not yet done), loop to re-evaluate
    // the next seq step in the same tick. Clear humanConfirmed so a confirmation is
    // one-shot: a later humanGate in the same seq must be confirmed afresh rather
    // than auto-passing on the previous step's confirmation.
    if (result.seqIndex !== (currentState.seqIndex ?? 0)) {
      currentState = { ...currentState, seqIndex: result.seqIndex, humanConfirmed: false };
      continue;
    }

    // Not done, not gating, no seq progress → inject the phase intent
    const text = intentToText(phase.intent, ctx.agentKind);
    return {
      kind: "inject",
      text,
      nextState: {
        ...currentState,
        goalIterations: (currentState.goalIterations ?? 0) + 1,
        seqIndex: result.seqIndex,
      },
    };
  }
}
