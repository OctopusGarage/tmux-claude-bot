import { describe, expect, it } from "vitest";
import { govern } from "../../src/core/autopilot/governor.js";
import { defaultState, type SessionSignal } from "../../src/core/autopilot/types.js";

const cfg = {
  tickMs: 8000,
  idleGraceMs: 20000,
  cooldownMs: 30000,
  maxIterations: 3,
  maxWallClockMs: 3600000,
  idlePromptText: "继续",
  apiErrorPromptText: "重试",
  maxRecoveryAttempts: 2,
  retry: { maxRetries: 2, baseDelayMs: 1000, backoffFactor: 2, maxDelayMs: 8000, jitter: false },
  goalsDir: "",
  usagePausePct: 0,
  keepAliveDoneMarker: "TASK_DONE",
  keepAliveDonePrompt: "完成后回复 [TASK_DONE]",
  maxRounds: 10,
};
const sig = (digest = "d1", progressAt = 0): SessionSignal => ({
  session: "s1",
  busy: false,
  idleForMs: 999999,
  queueEmpty: true,
  turnFinished: false,
  pane: { inputPromptWaiting: false, apiError: false, hardStop: false },
  progressAt,
  sentinels: [],
  // digest is derived inside govern from the signal; emulate by varying pane:
  ...(digest === "d2"
    ? { pane: { inputPromptWaiting: true, apiError: false, hardStop: false } }
    : {}),
});
const ctx = (over = {}) => ({
  state: { ...defaultState(), pureKeepAlive: true, startedAt: 0, ...over },
  config: cfg,
  now: 1_000_000,
});

describe("govern", () => {
  it("passes a fresh nudge through and advances counters", () => {
    const g = govern(
      { ruleId: "idle-unfinished", action: { kind: "nudge", text: "继续" } },
      sig(),
      ctx(),
    );
    expect(g.action).toEqual({ kind: "nudge", text: "继续" });
    expect(g.state.iterations).toBe(1);
    expect(g.state.cooldownUntil).toBe(1_000_000 + cfg.cooldownMs);
  });

  it("suppresses an idle nudge during cooldown", () => {
    const g = govern(
      { ruleId: "idle-unfinished", action: { kind: "nudge", text: "继续" } },
      sig(),
      ctx({ cooldownUntil: 2_000_000 }),
    );
    expect(g.action.kind).toBe("none");
  });

  it("stops when iteration cap is reached", () => {
    const g = govern(
      { ruleId: "idle-unfinished", action: { kind: "nudge", text: "继续" } },
      sig(),
      ctx({ iterations: 3 }),
    );
    expect(g.action.kind).toBe("stop");
  });

  it("pauses (conservative) after api retries are exhausted", () => {
    const g = govern(
      { ruleId: "api-error", action: { kind: "nudge", text: "继续" } },
      sig(),
      ctx({ apiRetries: 2, lastNudgeAt: 0 }),
    );
    expect(g.action.kind).toBe("pauseNotify");
  });

  it("pauses after recovery attempts are exhausted", () => {
    const g = govern(
      { ruleId: "stuck-prompt", action: { kind: "recover" } },
      sig("d2"),
      ctx({ recoveries: 2 }),
    );
    expect(g.action.kind).toBe("pauseNotify");
  });

  it("passes pauseNotify and stop intents straight through", () => {
    expect(
      govern({ ruleId: "hard-stop", action: { kind: "pauseNotify", reason: "x" } }, sig(), ctx())
        .action.kind,
    ).toBe("pauseNotify");
  });

  it("stops when wall-clock budget is exhausted", () => {
    // startedAt = 0, now = 1_000_000, maxWallClockMs = 3_600_000 — set startedAt so elapsed >= max
    const g = govern(
      { ruleId: "idle-unfinished", action: { kind: "nudge", text: "继续" } },
      sig(),
      ctx({ startedAt: 1_000_000 - cfg.maxWallClockMs, iterations: 0 }),
    );
    expect(g.action.kind).toBe("stop");
    expect((g.action as { kind: string; reason?: string }).reason).toMatch(/wall-clock/);
  });

  it("stops on loop detection (same digest + same action, iterations > 0)", () => {
    // digestOf(sig()) with default pane and progressAt=0 = "|u|0" (no flags, turnFinished=false)
    const expectedDigest = "|u|0";
    const g = govern(
      { ruleId: "idle-unfinished", action: { kind: "nudge", text: "继续" } },
      sig(),
      ctx({ lastSignalDigest: expectedDigest, lastActionKind: "nudge", iterations: 1 }),
    );
    expect(g.action.kind).toBe("stop");
    expect((g.action as { kind: string; reason?: string }).reason).toMatch(/no progress/);
  });

  it("returns none while still inside api-error backoff window", () => {
    // apiRetries=1, baseDelayMs=1000, backoffFactor=2 → nextDelayMs = 2000; lastNudgeAt=999_000, now=1_000_000 → elapsed=1000 < 2000
    const g = govern(
      { ruleId: "api-error", action: { kind: "nudge", text: "继续" } },
      sig(),
      ctx({ apiRetries: 1, lastNudgeAt: 999_000 }),
    );
    expect(g.action.kind).toBe("none");
    expect(g.state.apiRetries).toBe(1); // counters must not advance
  });

  it("nudges and advances apiRetries when api-error backoff window has elapsed", () => {
    // apiRetries=0, baseDelayMs=1000 → nextDelayMs = 1000; lastNudgeAt=undefined → backoff elapsed
    const prevRetries = 0;
    const g = govern(
      { ruleId: "api-error", action: { kind: "nudge", text: "继续" } },
      sig(),
      ctx({ apiRetries: prevRetries }),
    );
    expect(g.action.kind).toBe("nudge");
    expect(g.state.apiRetries).toBe(prevRetries + 1);
  });

  // BUG 1 regression: advanced progressAt prevents false loop-detection trip on keep-alive
  it("second idle nudge with advanced progressAt does NOT trip loop-detection (keep-alive continues)", () => {
    // First nudge stored digest "|u|1000" (progressAt=1000).
    // Second tick: progressAt advanced to 2000 → digest "|u|2000" differs → not a loop.
    const firstDigest = "|u|1000";
    const g = govern(
      { ruleId: "idle-unfinished", action: { kind: "nudge", text: "继续" } },
      sig("d1", 2000), // progressAt=2000
      ctx({ lastSignalDigest: firstDigest, lastActionKind: "nudge", iterations: 1 }),
    );
    expect(g.action.kind).toBe("nudge");
  });

  // BUG 1 regression: repeated api-error nudges are governed by retry budget, not loop-detection
  it("repeated api-error nudges run to the retry budget without hitting loop-detection", () => {
    // With apiRetries=1 (below maxRetries=2) and matching prior digest, loop-detection must be skipped.
    // digestOf(sig()) with progressAt=0 = "|u|0"
    const sameDigest = "|u|0";
    const g = govern(
      { ruleId: "api-error", action: { kind: "nudge", text: "继续" } },
      sig(), // progressAt=0 → same digest
      ctx({
        apiRetries: 1,
        lastNudgeAt: 0,
        lastSignalDigest: sameDigest,
        lastActionKind: "nudge",
        iterations: 1,
      }),
    );
    // Should nudge (budget not exhausted) rather than stop (loop-detection)
    expect(g.action.kind).toBe("nudge");
    expect(g.state.apiRetries).toBe(2);
  });

  // TEST GAP 3: recover action advances recoveries counter and resets apiRetries
  it("recover action advances recoveries to prev+1 and resets apiRetries to 0", () => {
    const g = govern(
      { ruleId: "stuck-prompt", action: { kind: "recover" } },
      sig("d2"),
      ctx({ recoveries: 1, apiRetries: 2, iterations: 1 }),
    );
    expect(g.action.kind).toBe("recover");
    expect(g.state.recoveries).toBe(2); // prev 1 → 2
    expect(g.state.apiRetries).toBe(0); // reset
  });

  // TEST GAP 4: iteration cap is the total backstop for any execute-class action
  it("iteration cap stops any nudge or recover when maxIterations is reached", () => {
    const atCap = ctx({ iterations: cfg.maxIterations }); // iterations === cap
    const nudgeResult = govern(
      { ruleId: "idle-unfinished", action: { kind: "nudge", text: "继续" } },
      sig(),
      atCap,
    );
    expect(nudgeResult.action.kind).toBe("stop");
    expect((nudgeResult.action as { kind: string; reason?: string }).reason).toMatch(
      /max iterations/,
    );

    const recoverResult = govern(
      { ruleId: "stuck-prompt", action: { kind: "recover" } },
      sig("d2"),
      atCap,
    );
    expect(recoverResult.action.kind).toBe("stop");
  });

  it("an idle nudge resets apiRetries (the API error has cleared)", () => {
    const g = govern(
      { ruleId: "idle-unfinished", action: { kind: "nudge", text: "继续" } },
      sig(),
      ctx({ apiRetries: 3 }),
    );
    expect(g.action.kind).toBe("nudge");
    expect(g.state.apiRetries).toBe(0);
  });
});
