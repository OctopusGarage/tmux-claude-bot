import { describe, expect, it } from "vitest";
import { planGoalFinalize } from "../../src/core/autopilot/goal-finalize-plan.js";
import { startCycleState, startGoalState } from "../../src/core/autopilot/goals/goal-state.js";
import { defaultState } from "../../src/core/autopilot/types.js";

describe("planGoalFinalize", () => {
  it("advances to the next goal and schedules the configured between-goals context op", () => {
    const state = startCycleState(defaultState(), ["fix-tests", "code-review"], 1);

    const plan = planGoalFinalize({
      session: "s1",
      goalId: "fix-tests",
      nextState: state,
      reason: "done",
      betweenGoals: "compact",
    });

    expect(plan.kind).toBe("advance");
    expect(plan.state).toMatchObject({
      enabled: true,
      goalId: "code-review",
      queuePos: 1,
      pendingContextOp: "compact",
    });
    expect(plan.notice).toEqual({
      kind: "goalAdvance",
      session: "s1",
      goalId: "code-review",
      pos: 2,
      total: 2,
      round: 1,
      rounds: 1,
    });
    expect(plan.action).toEqual({ kind: "none" });
  });

  it("does not schedule a between-goals context op when configured as none", () => {
    const state = startCycleState(defaultState(), ["fix-tests", "code-review"], 1);

    const plan = planGoalFinalize({
      session: "s1",
      goalId: "fix-tests",
      nextState: state,
      reason: "done",
      betweenGoals: "none",
    });

    expect(plan.kind).toBe("advance");
    expect(plan.state.pendingContextOp).toBeUndefined();
  });

  it("stops a single completed goal and plans the complete notice", () => {
    const state = startGoalState(defaultState(), "fix-tests");

    const plan = planGoalFinalize({
      session: "s1",
      goalId: "fix-tests",
      nextState: state,
      reason: "done",
      betweenGoals: "compact",
    });

    expect(plan.kind).toBe("done");
    expect(plan.state).toMatchObject({ enabled: false, goalId: "fix-tests" });
    expect(plan.notice).toEqual({ kind: "complete", session: "s1", goalId: "fix-tests" });
    expect(plan.action).toEqual({ kind: "pauseNotify", reason: "done" });
  });

  it("stops a completed multi-round cycle with a cycle-complete notice", () => {
    const state = {
      ...startCycleState(defaultState(), ["fix-tests"], 2),
      roundsDone: 1,
    };

    const plan = planGoalFinalize({
      session: "s1",
      goalId: "fix-tests",
      nextState: state,
      reason: "done",
      betweenGoals: "clear",
    });

    expect(plan.kind).toBe("done");
    expect(plan.state.enabled).toBe(false);
    expect(plan.state.pendingContextOp).toBeUndefined();
    expect(plan.notice).toEqual({ kind: "cycleComplete", session: "s1", rounds: 2 });
  });
});
