import { describe, expect, it } from "vitest";
import { decide } from "../../src/core/autopilot/rules.js";
import { defaultState, type SessionSignal } from "../../src/core/autopilot/types.js";

const cfg = {
  tickMs: 8000,
  idleGraceMs: 20000,
  cooldownMs: 30000,
  maxIterations: 30,
  maxWallClockMs: 3600000,
  idlePromptText: "继续",
  apiErrorPromptText: "重试",
  maxRecoveryAttempts: 5,
  retry: { maxRetries: 5, baseDelayMs: 30000, backoffFactor: 2, maxDelayMs: 120000, jitter: false },
  retryBusy: {
    maxRetries: 5,
    baseDelayMs: 180000,
    backoffFactor: 2,
    maxDelayMs: 600000,
    jitter: false,
  },
  goalsDir: "",
  usagePausePct: 0,
  keepAliveDoneMarker: "TASK_DONE",
  keepAliveDonePrompt: "完成后回复 [TASK_DONE]",
  maxRounds: 10,
  betweenGoals: "compact" as const,
};
const ctx = (over = {}) => ({
  state: { ...defaultState(), pureKeepAlive: true, ...over },
  config: cfg,
  now: 100000,
});
const sig = (over: Partial<SessionSignal>): SessionSignal => ({
  session: "s1",
  busy: false,
  idleForMs: 999999,
  queueEmpty: true,
  turnFinished: false,
  pane: { inputPromptWaiting: false, apiError: false, serverBusy: false, hardStop: false },
  progressAt: 0,
  sentinels: [],
  ...over,
});

describe("decide", () => {
  it("hard stop → pauseNotify", () => {
    const d = decide(
      sig({
        pane: { inputPromptWaiting: false, apiError: false, serverBusy: false, hardStop: true },
      }),
      ctx(),
    );
    expect(d.action.kind).toBe("pauseNotify");
  });

  it("api error → nudge (governor adds backoff later)", () => {
    const d = decide(
      sig({
        pane: { inputPromptWaiting: false, apiError: true, serverBusy: false, hardStop: false },
      }),
      ctx(),
    );
    expect(d).toEqual({ ruleId: "api-error", action: { kind: "nudge", text: "重试" } });
  });

  it("waiting prompt → recover", () => {
    const d = decide(
      sig({
        pane: { inputPromptWaiting: true, apiError: false, serverBusy: false, hardStop: false },
      }),
      ctx(),
    );
    expect(d.action.kind).toBe("recover");
  });

  it("idle + unfinished + keepalive → nudge (with completion prompt)", () => {
    const d = decide(sig({ idleForMs: 999999, turnFinished: false }), ctx());
    expect(d).toEqual({
      ruleId: "idle-unfinished",
      action: { kind: "nudge", text: "继续\n完成后回复 [TASK_DONE]" },
    });
  });

  it("busy → none", () => {
    expect(decide(sig({ busy: true }), ctx()).action.kind).toBe("none");
  });

  it("idle but keepalive off and no goal → none", () => {
    expect(decide(sig({}), ctx({ pureKeepAlive: false })).action.kind).toBe("none");
  });

  it("idle but not yet past the grace window → none", () => {
    expect(decide(sig({ idleForMs: 5000 }), ctx()).action.kind).toBe("none");
  });

  it("idle + unfinished + goalId (keepalive off) → nudge (goal sessions fire the rule)", () => {
    const d = decide(
      sig({ idleForMs: 999999, turnFinished: false }),
      ctx({ pureKeepAlive: false, goalId: "fix-tests" }),
    );
    expect(d).toEqual({ ruleId: "idle-unfinished", action: { kind: "nudge", text: "继续" } });
  });

  it("idle + unfinished + goal + humanGatePending → none (gate suppresses keep-alive nudge)", () => {
    const d = decide(
      sig({ idleForMs: 999999, turnFinished: false }),
      ctx({ pureKeepAlive: false, goalId: "fix-tests", humanGatePending: true }),
    );
    expect(d.action.kind).toBe("none");
  });

  it("idle + unfinished + goal + humanGatePending false → nudge (gate not pending, rule fires)", () => {
    const d = decide(
      sig({ idleForMs: 999999, turnFinished: false }),
      ctx({ pureKeepAlive: false, goalId: "fix-tests", humanGatePending: false }),
    );
    expect(d).toEqual({ ruleId: "idle-unfinished", action: { kind: "nudge", text: "继续" } });
  });

  it("pure keep-alive nudge appends the completion prompt", () => {
    const d = decide(sig({}), ctx({ pureKeepAlive: true }));
    expect(d.action.kind).toBe("nudge");
    if (d.action.kind === "nudge") expect(d.action.text).toContain("TASK_DONE");
  });
});
