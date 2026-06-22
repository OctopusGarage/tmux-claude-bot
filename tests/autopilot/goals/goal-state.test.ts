import { describe, expect, it } from "vitest";
import {
  advanceCycle,
  advancePhaseState,
  startCycleState,
  startGoalState,
} from "../../../src/core/autopilot/goals/goal-state.js";
import { defaultState } from "../../../src/core/autopilot/types.js";

describe("goal-state", () => {
  it("startGoalState enables, sets goal at phase 0, fresh counters", () => {
    const s = startGoalState(defaultState(), "fix-tests");
    expect(s.enabled).toBe(true);
    expect(s.goalId).toBe("fix-tests");
    expect(s.phaseIndex).toBe(0);
    expect(s.goalIterations).toBe(0);
    expect(s.humanGatePending).toBeFalsy();
  });
  it("startGoalState clears a prior optOut (starting a goal is an explicit engage)", () => {
    const s = startGoalState({ ...defaultState(), optOut: true }, "fix-tests");
    expect(s.optOut).toBe(false);
  });
  it("advancePhaseState bumps the phase and resets per-phase gate/seq", () => {
    const s = advancePhaseState({
      ...startGoalState(defaultState(), "code-review"),
      seqIndex: 1,
      humanGatePending: true,
    });
    expect(s.phaseIndex).toBe(1);
    expect(s.seqIndex).toBe(0);
    expect(s.humanGatePending).toBeFalsy();
  });
});

describe("goal cycle state", () => {
  it("startCycleState seeds the queue, rounds, and the first active goal", () => {
    const s = startCycleState(defaultState(), ["fix-tests", "code-review"], 2);
    expect(s.enabled).toBe(true);
    expect(s.goalQueue).toEqual(["fix-tests", "code-review"]);
    expect(s.rounds).toBe(2);
    expect(s.queuePos).toBe(0);
    expect(s.roundsDone).toBe(0);
    expect(s.goalId).toBe("fix-tests"); // mirror of the active goal
    expect(s.phaseIndex).toBe(0);
  });

  it("advanceCycle walks queue then rounds then done", () => {
    let s = startCycleState(defaultState(), ["a", "b"], 2);
    // finalize a -> next goal b
    let step = advanceCycle(s);
    expect(step.kind).toBe("next");
    if (step.kind === "next") {
      expect(step.state.queuePos).toBe(1);
      expect(step.state.goalId).toBe("b");
      expect(step.state.roundsDone).toBe(0);
      expect(step.state.phaseIndex).toBe(0); // phase state reset for the new goal
      s = step.state;
    }
    // finalize b -> wrap to round 2, goal a
    step = advanceCycle(s);
    expect(step.kind).toBe("next");
    if (step.kind === "next") {
      expect(step.state.queuePos).toBe(0);
      expect(step.state.goalId).toBe("a");
      expect(step.state.roundsDone).toBe(1);
      s = step.state;
    }
    // finalize a (round 2)
    expect(advanceCycle(s).kind).toBe("next"); // -> goal b, still round 2
    s = (advanceCycle(s) as { kind: "next"; state: typeof s }).state;
    // finalize b (round 2) -> done
    expect(advanceCycle(s).kind).toBe("done");
  });

  it("single goal, single round finalizes straight to done", () => {
    const s = startCycleState(defaultState(), ["a"], 1);
    expect(advanceCycle(s).kind).toBe("done");
  });
});
