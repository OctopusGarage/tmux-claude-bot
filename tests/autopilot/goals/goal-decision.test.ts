import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
let projectDir: string;
const ctx = {
  agentKind: "claude" as const,
  runCheck: async () => ({ ok: true }),
  cwd: undefined as string | undefined,
};
beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), "tcb-gd-proj-"));
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  ctx.cwd = projectDir;
});
afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

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

  it("code-review chains review → fix → simplify, then gates on human confirm", async () => {
    const g = getGoal("code-review");
    if (!g) throw new Error("goal not found");
    expect(g.phases.map((p) => p.id)).toEqual(["review", "fix", "simplify"]);

    // review (phase 0): [REVIEW_DONE] → advance to fix
    const r0 = await decideGoal(
      g,
      sig({ sentinels: ["REVIEW_DONE"] }),
      startGoalState(defaultState(), "code-review"),
      ctx,
    );
    expect(r0.kind).toBe("advance");
    if (r0.kind !== "advance") return;
    expect(r0.nextState.phaseIndex).toBe(1);

    // fix (phase 1): [FIX_DONE] → advance to simplify
    const r1 = await decideGoal(g, sig({ sentinels: ["FIX_DONE"] }), r0.nextState, ctx);
    expect(r1.kind).toBe("advance");
    if (r1.kind !== "advance") return;
    expect(r1.nextState.phaseIndex).toBe(2);

    // simplify (phase 2): [GOAL_DONE] reaches the human gate
    const r2 = await decideGoal(g, sig({ sentinels: ["GOAL_DONE"] }), r1.nextState, ctx);
    expect(r2.kind).toBe("awaitHuman");
    if (r2.kind !== "awaitHuman") return;

    // confirm → finalize the whole goal
    const r3 = await decideGoal(
      g,
      sig({ sentinels: ["GOAL_DONE"] }),
      { ...r2.nextState, humanConfirmed: true, humanGatePending: false },
      ctx,
    );
    expect(r3.kind).toBe("finalize");
  });

  it("improve-architecture chains audit → improve (test-gated) → human confirm", async () => {
    const g = getGoal("improve-architecture");
    if (!g) throw new Error("goal not found");
    expect(g.phases.map((p) => p.id)).toEqual(["audit", "improve"]);

    // audit (phase 0): [AUDIT_DONE] → advance to improve
    const r0 = await decideGoal(
      g,
      sig({ sentinels: ["AUDIT_DONE"] }),
      startGoalState(defaultState(), "improve-architecture"),
      ctx,
    );
    expect(r0.kind).toBe("advance");
    if (r0.kind !== "advance") return;
    expect(r0.nextState.phaseIndex).toBe(1);

    // improve (phase 1): [GOAL_DONE] + a green detectCheck reaches the human gate
    // (ctx.cwd has a package.json test script, ctx.runCheck returns ok).
    const r1 = await decideGoal(g, sig({ sentinels: ["GOAL_DONE"] }), r0.nextState, ctx);
    expect(r1.kind).toBe("awaitHuman");
    if (r1.kind !== "awaitHuman") return;

    // confirm → finalize
    const r2 = await decideGoal(
      g,
      sig({ sentinels: ["GOAL_DONE"] }),
      { ...r1.nextState, humanConfirmed: true, humanGatePending: false },
      ctx,
    );
    expect(r2.kind).toBe("finalize");
  });

  it("improve-architecture will not finalize while the suite is red", async () => {
    const g = getGoal("improve-architecture");
    if (!g) throw new Error("goal not found");
    // phase 1 improve, agent claims GOAL_DONE but tests fail → keep injecting, no gate
    const s1 = { ...startGoalState(defaultState(), "improve-architecture"), phaseIndex: 1 };
    const r = await decideGoal(g, sig({ sentinels: ["GOAL_DONE"] }), s1, {
      ...ctx,
      runCheck: async () => ({ ok: false }),
    });
    expect(r.kind).toBe("inject");
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
