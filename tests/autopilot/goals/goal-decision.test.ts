import { describe, expect, it } from "vitest";
import { getGoal } from "../../../src/core/autopilot/goals/catalog.js";
import { decideGoal } from "../../../src/core/autopilot/goals/goal-decision.js";
import { startGoalState } from "../../../src/core/autopilot/goals/goal-state.js";
import type { Goal } from "../../../src/core/autopilot/goals/types.js";
import { defaultState, type SessionSignal } from "../../../src/core/autopilot/types.js";

const sig = (over: Partial<SessionSignal> = {}): SessionSignal => ({
  session: "s1",
  busy: false,
  idleForMs: 9e9,
  queueEmpty: true,
  turnFinished: false,
  pane: { inputPromptWaiting: false, apiError: false, serverBusy: false, hardStop: false },
  progressAt: 0,
  sentinels: [],
  ...over,
});
const ctx = { agentKind: "claude" as const, runCheck: async () => ({ ok: true }), cwd: undefined };

describe("decideGoal", () => {
  it("busy → none", async () => {
    const g = getGoal("fix-tests");
    if (!g) throw new Error("goal not found");
    const r = await decideGoal(
      g,
      sig({ busy: true }),
      startGoalState(defaultState(), "fix-tests"),
      ctx,
    );
    expect(r.kind).toBe("none");
  });
  it("queued work (queueEmpty false) → none, even when not busy", async () => {
    const g = getGoal("fix-tests");
    if (!g) throw new Error("goal not found");
    const r = await decideGoal(
      g,
      sig({ busy: false, queueEmpty: false }),
      startGoalState(defaultState(), "fix-tests"),
      ctx,
    );
    expect(r.kind).toBe("none");
  });
  it("phaseIndex past the last phase → finalize (all phases complete)", async () => {
    const g = getGoal("fix-tests");
    if (!g) throw new Error("goal not found");
    const r = await decideGoal(
      g,
      sig(),
      { ...startGoalState(defaultState(), "fix-tests"), phaseIndex: g.phases.length },
      ctx,
    );
    expect(r.kind).toBe("finalize");
  });
  it("idle + not done → inject the phase intent", async () => {
    const g = getGoal("fix-tests");
    if (!g) throw new Error("goal not found");
    const r = await decideGoal(g, sig(), startGoalState(defaultState(), "fix-tests"), {
      ...ctx,
      runCheck: async () => ({ ok: false }),
    });
    expect(r.kind).toBe("inject");
    if (r.kind === "inject") expect(r.text).toContain("failing tests");
  });
  it("sentinel + check satisfied on a single-phase goal → finalize", async () => {
    const g = getGoal("fix-tests");
    if (!g) throw new Error("goal not found");
    const r = await decideGoal(
      g,
      sig({ sentinels: ["GOAL_DONE"] }),
      startGoalState(defaultState(), "fix-tests"),
      ctx,
    );
    expect(r.kind).toBe("finalize");
  });
  it("humanGate pending → awaitHuman once then none", async () => {
    const g = getGoal("add-feature");
    if (!g) throw new Error("goal not found");
    const s0 = startGoalState(defaultState(), "add-feature");
    const r0 = await decideGoal(g, sig({ sentinels: ["GOAL_DONE"] }), s0, ctx);
    expect(r0.kind).toBe("awaitHuman");
    if (r0.kind === "awaitHuman") {
      const r1 = await decideGoal(g, sig({ sentinels: ["GOAL_DONE"] }), r0.nextState, ctx);
      expect(r1.kind).toBe("none");
    }
  });
  it("multi-phase goal advances to the next phase when a phase completes", async () => {
    const g = getGoal("code-review");
    if (!g) throw new Error("goal not found");
    const s0 = startGoalState(defaultState(), "code-review");
    const r = await decideGoal(g, sig({ sentinels: ["REVIEW_DONE"] }), s0, ctx);
    expect(r.kind).toBe("advance");
    if (r.kind === "advance") expect(r.nextState.phaseIndex).toBe(1);
  });

  it("a seq with two human gates requires a fresh confirm for each (one-shot confirm)", async () => {
    const twoGates: Goal = {
      id: "two-gates",
      titleKey: "Two gates",
      phases: [
        {
          id: "p",
          intent: { kind: "prompt", text: "x" },
          done: { kind: "seq", of: [{ kind: "humanGate" }, { kind: "humanGate" }] },
        },
      ],
    };
    // First gate already confirmed; the second must NOT auto-pass on the same confirm.
    const s0 = {
      ...startGoalState(defaultState(), "two-gates"),
      humanConfirmed: true,
      seqIndex: 0,
    };
    const r = await decideGoal(twoGates, sig(), s0, ctx);
    expect(r.kind).toBe("awaitHuman");
  });
});
