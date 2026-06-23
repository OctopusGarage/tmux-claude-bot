import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAutopilotVerb } from "../../src/core/autopilot/controls.js";
import { startCycleState, startGoalState } from "../../src/core/autopilot/goals/goal-state.js";
import { AutopilotStore } from "../../src/core/autopilot/state-store.js";
import { runSupervisorTick } from "../../src/core/autopilot/supervisor.js";
import { defaultState } from "../../src/core/autopilot/types.js";
import { messages } from "../../src/core/i18n/index.js";

const autopilotCfg = {
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
};

function makeDeps(pane: string) {
  const enqueue = vi.fn(() => "queued" as const);
  const broadcast = vi.fn(async () => {});
  return {
    enqueue,
    broadcast,
    deps: {
      config: { autopilot: autopilotCfg },
      bridge: {
        capturePane: async () => pane,
        sendRawKey: vi.fn(async () => {}),
        sendKeys: vi.fn(async () => {}),
      },
      queue: { size: () => 0, isSessionProcessing: () => false, enqueue },
      notifier: { broadcast },
      configResolver: { detectAgentKind: async () => null },
    } as never,
  };
}
const probes = { paneIsAnimating: async () => false, lastActivityAt: async () => null };

let dir: string;
let store: AutopilotStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tcb-sup-"));
  process.env.TCB_STATE_DIR = dir;
  store = new AutopilotStore();
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("runSupervisorTick", () => {
  it("disabled session → no-op", async () => {
    const { deps, enqueue } = makeDeps("");
    const action = await runSupervisorTick(deps, store, "s1", 1000, probes);
    expect(action.kind).toBe("none");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("idle enabled keep-alive session → enqueues a nudge", async () => {
    store.set("s1", { ...defaultState(), enabled: true, pureKeepAlive: true });
    const { deps, enqueue } = makeDeps("");
    const action = await runSupervisorTick(deps, store, "s1", 1_000_000, probes);
    expect(action.kind).toBe("nudge");
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "text",
        text: "继续\n完成后回复 [TASK_DONE]",
        sessionName: "s1",
        ephemeral: true,
      }),
    );
    expect(store.get("s1").iterations).toBe(1);
  });

  it("hard stop → disables session and notifies owner", async () => {
    store.set("s1", { ...defaultState(), enabled: true, pureKeepAlive: true });
    const { deps, broadcast } = makeDeps("You are out of credits");
    const action = await runSupervisorTick(deps, store, "s1", 1_000_000, probes);
    expect(action.kind).toBe("pauseNotify");
    expect(store.get("s1").enabled).toBe(false);
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it("stuck input prompt → recover: ESC + backspaces + the resume prompt", async () => {
    store.set("s1", { ...defaultState(), enabled: true, pureKeepAlive: true });
    const { deps } = makeDeps("│ > "); // input box → stuck-prompt rule → recover
    const bridge = (
      deps as never as {
        bridge: { sendRawKey: ReturnType<typeof vi.fn>; sendKeys: ReturnType<typeof vi.fn> };
      }
    ).bridge;
    const action = await runSupervisorTick(deps, store, "s1", 1_000_000, probes);
    expect(action.kind).toBe("recover");
    expect(bridge.sendRawKey).toHaveBeenCalledWith("Escape", "s1");
    expect(bridge.sendRawKey).toHaveBeenCalledWith("BSpace", "s1");
    expect(bridge.sendKeys).toHaveBeenCalledWith(autopilotCfg.idlePromptText, "s1");
    expect(store.get("s1").recoveries).toBe(1);
  });

  // BUG 2 regression: concurrent /autopilot off during execute must not be resurrected
  it("concurrent disable during tick is not overwritten by the tick's write-back", async () => {
    store.set("s1", { ...defaultState(), enabled: true, pureKeepAlive: true });
    // Make enqueue flip enabled=false as a side-effect, simulating /autopilot off mid-tick.
    const broadcast = vi.fn(async () => {});
    const enqueue = vi.fn(() => {
      store.set("s1", { ...store.get("s1"), enabled: false });
      return "queued" as const;
    });
    const deps = {
      config: { autopilot: autopilotCfg },
      bridge: {
        capturePane: async () => "",
        sendRawKey: vi.fn(async () => {}),
        sendKeys: vi.fn(async () => {}),
      },
      queue: { size: () => 0, isSessionProcessing: () => false, enqueue },
      notifier: { broadcast },
      configResolver: { detectAgentKind: async () => null },
    } as never;
    await runSupervisorTick(deps, store, "s1", 1_000_000, probes);
    expect(store.get("s1").enabled).toBe(false);
  });

  it("goal session: idle + check failing + no sentinel → enqueues phase intent (contains 'failing tests')", async () => {
    store.set("s1", startGoalState(defaultState(), "fix-tests"));
    const { deps, enqueue } = makeDeps("");
    const runCheck = vi.fn(async () => ({ ok: false }));
    const action = await runSupervisorTick(deps, store, "s1", 1_000_000, {
      ...probes,
      runCheck,
    });
    expect(action.kind).toBe("nudge");
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "text",
        sessionName: "s1",
        ephemeral: true,
        text: expect.stringContaining("failing tests"),
      }),
    );
  });

  it("goal session: sentinel GOAL_DONE + passing check → finalizes (disables + broadcasts)", async () => {
    store.set("s1", startGoalState(defaultState(), "fix-tests"));
    const { deps, enqueue: _enqueue, broadcast } = makeDeps("");
    const runCheck = vi.fn(async () => ({ ok: true }));
    await runSupervisorTick(deps, store, "s1", 1_000_000, {
      ...probes,
      runCheck,
      recentAssistant: async () => "[GOAL_DONE]",
    });
    expect(store.get("s1").enabled).toBe(false);
    // single goal (no cycle) → the `complete` notice, not `cycleComplete`
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "complete", goalId: "fix-tests" }),
    );
  });

  it("usage gate: fiveHourPct >= usagePausePct → disables session + broadcasts, no inject", async () => {
    store.set("s1", startGoalState(defaultState(), "fix-tests"));
    const enqueue = vi.fn(() => "queued" as const);
    const broadcast = vi.fn(async () => {});
    const deps90 = {
      config: { autopilot: { ...autopilotCfg, usagePausePct: 90 } },
      bridge: {
        capturePane: async () => "",
        sendRawKey: vi.fn(async () => {}),
        sendKeys: vi.fn(async () => {}),
      },
      queue: { size: () => 0, isSessionProcessing: () => false, enqueue },
      notifier: { broadcast },
      configResolver: { detectAgentKind: async () => null },
    } as never;
    const readUsage = vi.fn(async () => ({
      sessionId: "s",
      contextPct: null,
      fiveHourPct: 95,
      fiveHourReset: null,
      sevenDayPct: null,
      sevenDayReset: null,
      updatedAt: Date.now() / 1000,
    }));
    const action = await runSupervisorTick(deps90, store, "s1", 1_000_000, {
      ...probes,
      readUsage,
    });
    expect(action.kind).toBe("pauseNotify");
    expect(store.get("s1").enabled).toBe(false);
    expect(broadcast).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("usage gate: all pcts below threshold → goal proceeds (inject enqueued)", async () => {
    store.set("s1", startGoalState(defaultState(), "fix-tests"));
    const enqueue = vi.fn(() => "queued" as const);
    const broadcast = vi.fn(async () => {});
    const deps90 = {
      config: { autopilot: { ...autopilotCfg, usagePausePct: 90 } },
      bridge: {
        capturePane: async () => "",
        sendRawKey: vi.fn(async () => {}),
        sendKeys: vi.fn(async () => {}),
      },
      queue: { size: () => 0, isSessionProcessing: () => false, enqueue },
      notifier: { broadcast },
      configResolver: { detectAgentKind: async () => null },
    } as never;
    const readUsage = vi.fn(async () => ({
      sessionId: "s",
      contextPct: null,
      fiveHourPct: 10,
      fiveHourReset: null,
      sevenDayPct: null,
      sevenDayReset: null,
      updatedAt: Date.now() / 1000,
    }));
    const runCheck = vi.fn(async () => ({ ok: false }));
    const action = await runSupervisorTick(deps90, store, "s1", 1_000_000, {
      ...probes,
      readUsage,
      runCheck,
    });
    expect(action.kind).toBe("nudge");
    expect(enqueue).toHaveBeenCalled();
  });

  it("usage gate: a concurrent /autopilot off DURING the usage read is not clobbered", async () => {
    store.set("s1", startGoalState(defaultState(), "fix-tests"));
    const broadcast = vi.fn(async () => {});
    const deps90 = {
      config: { autopilot: { ...autopilotCfg, usagePausePct: 90 } },
      bridge: {
        capturePane: async () => "",
        sendRawKey: vi.fn(async () => {}),
        sendKeys: vi.fn(async () => {}),
      },
      queue: { size: () => 0, isSessionProcessing: () => false, enqueue: vi.fn(() => "queued") },
      notifier: { broadcast },
      configResolver: { detectAgentKind: async () => null },
    } as never;
    const readUsage = vi.fn(async () => {
      store.set("s1", { ...store.get("s1"), enabled: false, optOut: true }); // /autopilot off mid-read
      return {
        sessionId: "s",
        contextPct: null,
        fiveHourPct: 95,
        fiveHourReset: null,
        sevenDayPct: null,
        sevenDayReset: null,
        updatedAt: Date.now() / 1000,
      };
    });
    const action = await runSupervisorTick(deps90, store, "s1", 1_000_000, {
      ...probes,
      readUsage,
    });
    expect(action.kind).toBe("pauseNotify");
    expect(store.get("s1").optOut).toBe(true); // the concurrent off survives
    expect(broadcast).not.toHaveBeenCalled(); // guarded write/broadcast skipped
  });

  // Finding #3: goal runs must honour the wall-clock budget (govern() only covers Layer-1).
  it("goal past the wall-clock budget → stop + disable", async () => {
    store.set("s1", { ...startGoalState(defaultState(), "fix-tests"), startedAt: 0 });
    const { deps, broadcast } = makeDeps("");
    const action = await runSupervisorTick(deps, store, "s1", autopilotCfg.maxWallClockMs + 1, {
      ...probes,
      runCheck: async () => ({ ok: false }),
    });
    expect(action.kind).toBe("stop");
    expect(store.get("s1").enabled).toBe(false);
    expect(broadcast).toHaveBeenCalled();
  });

  // Finding #2: a pending human gate must NOT fall through to Layer-1 recovery.
  it("pending human gate → does not fall through to Layer-1 recover", async () => {
    store.set("s1", {
      ...startGoalState(defaultState(), "add-feature"),
      seqIndex: 1,
      humanGatePending: true,
    });
    const { deps } = makeDeps("│ > "); // input box would match the stuck-prompt rule
    const sendRawKey = (deps as never as { bridge: { sendRawKey: ReturnType<typeof vi.fn> } })
      .bridge.sendRawKey;
    const action = await runSupervisorTick(deps, store, "s1", 1_000_000, {
      ...probes,
      runCheck: async () => ({ ok: false }),
    });
    expect(action.kind).toBe("none");
    expect(sendRawKey).not.toHaveBeenCalled(); // no recover injected during the gate wait
  });

  it("cycle: finalizing a non-last goal advances to the next (stays enabled, goalAdvance notice)", async () => {
    store.set("s1", startCycleState(defaultState(), ["fix-tests", "code-review"], 1));
    const { deps, broadcast } = makeDeps("");
    const action = await runSupervisorTick(deps, store, "s1", 1_000_000, {
      ...probes,
      runCheck: async () => ({ ok: true }), // fix-tests passes -> finalize -> advance
      recentAssistant: async () => "[GOAL_DONE]",
    });
    expect(action.kind).toBe("none");
    const s = store.get("s1");
    expect(s.enabled).toBe(true);
    expect(s.queuePos).toBe(1);
    expect(s.goalId).toBe("code-review");
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "goalAdvance",
        session: "s1",
        goalId: "code-review",
        pos: 2, // now on goal 2 of 2
        total: 2,
        round: 1,
        rounds: 1,
      }),
    );
  });

  it("keep-alive: completion marker present → stop + keepaliveDone, no nudge", async () => {
    store.set("s1", { ...defaultState(), enabled: true, pureKeepAlive: true });
    const { deps, enqueue, broadcast } = makeDeps("");
    const action = await runSupervisorTick(deps, store, "s1", 1_000_000, {
      ...probes,
      recentAssistant: async () => "...all done... [TASK_DONE]",
    });
    expect(action.kind).toBe("stop");
    expect(store.get("s1").enabled).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "keepaliveDone", session: "s1" }),
    );
  });

  it("cycle with a human-gate goal: gate pauses mid-cycle, confirm advances to the next goal", async () => {
    // add-feature is a single phase: done = seq[sentinel GOAL_DONE, humanGate]
    store.set("s1", startCycleState(defaultState(), ["add-feature", "fix-tests"], 1));
    const { deps, broadcast } = makeDeps("");
    const apProbes = { ...probes, recentAssistant: async () => "[GOAL_DONE]" };
    // tick 1: agent claims done -> seq advances to humanGate -> awaitHuman (paused, still on add-feature)
    await runSupervisorTick(deps, store, "s1", 1_000_000, apProbes);
    expect(store.get("s1").humanGatePending).toBe(true);
    expect(store.get("s1").goalId).toBe("add-feature");
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ kind: "awaitHuman" }));
    // user confirms
    applyAutopilotVerb(store, "s1", "confirm", messages("telegram"));
    // tick 2: finalize add-feature -> advanceCycle -> next goal fix-tests, gate state reset
    await runSupervisorTick(deps, store, "s1", 1_000_001, apProbes);
    const s = store.get("s1");
    expect(s.goalId).toBe("fix-tests");
    expect(s.queuePos).toBe(1);
    expect(s.humanGatePending).toBe(false);
    expect(s.humanConfirmed).toBe(false);
  });

  it("reject ('keep going') re-prompts the agent next tick instead of re-arming the gate", async () => {
    store.set("s1", startGoalState(defaultState(), "add-feature")); // seq[sentinel GOAL_DONE, humanGate]
    const { deps, enqueue } = makeDeps("");
    const apProbes = { ...probes, recentAssistant: async () => "[GOAL_DONE]" };
    await runSupervisorTick(deps, store, "s1", 1_000_000, apProbes); // → awaitHuman
    expect(store.get("s1").humanGatePending).toBe(true);
    // user rejects ("keep polishing")
    applyAutopilotVerb(store, "s1", "reject", messages("telegram"));
    expect(store.get("s1").reworkPending).toBe(true);
    expect(store.get("s1").seqIndex).toBe(0);
    enqueue.mockClear();
    // next tick: re-prompts the agent (enqueues the phase intent), clears reworkPending, sets cooldown
    const action = await runSupervisorTick(deps, store, "s1", 1_000_001, apProbes);
    expect(action.kind).toBe("nudge");
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ action: "text", sessionName: "s1", ephemeral: true }),
    );
    const after = store.get("s1");
    expect(after.reworkPending).toBeFalsy();
    expect(after.humanGatePending).toBeFalsy(); // did NOT re-arm the gate
    expect(after.cooldownUntil).toBe(1_000_001 + autopilotCfg.cooldownMs);
  });

  it("a confirm landing DURING the awaitHuman broadcast is not clobbered (write-before-broadcast)", async () => {
    store.set("s1", startGoalState(defaultState(), "add-feature")); // seq[sentinel GOAL_DONE, humanGate]
    // the gate broadcast simulates the owner tapping Confirm while the notice is in flight
    const broadcast = vi.fn(async (n: { kind: string }) => {
      if (n.kind === "awaitHuman") applyAutopilotVerb(store, "s1", "confirm", messages("telegram"));
    });
    const deps = {
      config: { autopilot: autopilotCfg },
      bridge: {
        capturePane: async () => "",
        sendRawKey: vi.fn(async () => {}),
        sendKeys: vi.fn(async () => {}),
      },
      queue: { size: () => 0, isSessionProcessing: () => false, enqueue: vi.fn(() => "queued") },
      notifier: { broadcast },
      configResolver: { detectAgentKind: async () => null },
    } as never;
    await runSupervisorTick(deps, store, "s1", 1_000_000, {
      ...probes,
      recentAssistant: async () => "[GOAL_DONE]",
    });
    // the confirm wins: gate cleared + confirmed, not overwritten back to pending
    expect(store.get("s1").humanGatePending).toBe(false);
    expect(store.get("s1").humanConfirmed).toBe(true);
  });

  // Finding #1: a /autopilot off that lands during the (long) goal check is not clobbered.
  it("concurrent /autopilot off during the goal check is not overwritten", async () => {
    store.set("s1", startGoalState(defaultState(), "fix-tests"));
    const { deps, enqueue } = makeDeps(""); // sentinel via recentAssistant so the check runs
    const runCheck = async () => {
      store.set("s1", { ...store.get("s1"), enabled: false, optOut: true }); // simulate /autopilot off
      return { ok: false };
    };
    const action = await runSupervisorTick(deps, store, "s1", 1_000_000, {
      ...probes,
      runCheck,
      recentAssistant: async () => "[GOAL_DONE]",
    });
    expect(action.kind).toBe("none");
    expect(enqueue).not.toHaveBeenCalled();
    expect(store.get("s1").enabled).toBe(false); // not resurrected
    expect(store.get("s1").optOut).toBe(true);
  });

  // Bug #3: a viaScheduler=true session at/over usagePausePct must NOT be disabled
  // by the supervisor's per-session usage-gate (the scheduler's pool-level quota
  // authority governs it instead).
  it("usage gate: viaScheduler session at/over threshold is NOT disabled by supervisor", async () => {
    store.set("s1", { ...startGoalState(defaultState(), "fix-tests"), viaScheduler: true });
    const enqueue = vi.fn(() => "queued" as const);
    const broadcast = vi.fn(async () => {});
    const deps90 = {
      config: { autopilot: { ...autopilotCfg, usagePausePct: 90 } },
      bridge: {
        capturePane: async () => "",
        sendRawKey: vi.fn(async () => {}),
        sendKeys: vi.fn(async () => {}),
      },
      queue: { size: () => 0, isSessionProcessing: () => false, enqueue },
      notifier: { broadcast },
      configResolver: { detectAgentKind: async () => null },
    } as never;
    const readUsage = vi.fn(async () => ({
      sessionId: "s",
      contextPct: null,
      fiveHourPct: 95, // above 90% threshold
      fiveHourReset: null,
      sevenDayPct: null,
      sevenDayReset: null,
      updatedAt: Date.now() / 1000,
    }));
    const runCheck = vi.fn(async () => ({ ok: false }));
    const action = await runSupervisorTick(deps90, store, "s1", 1_000_000, {
      ...probes,
      readUsage,
      runCheck,
    });
    // The usage gate is skipped for viaScheduler sessions — goal continues normally.
    expect(action.kind).not.toBe("pauseNotify");
    expect(store.get("s1").enabled).toBe(true); // not disabled by the usage gate
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "usage" }));
    // readUsage should NOT even be called (the gate is skipped before the read).
    expect(readUsage).not.toHaveBeenCalled();
  });

  // Contrast: a non-viaScheduler goal session at/over threshold IS still disabled.
  it("usage gate: non-viaScheduler session at/over threshold IS disabled", async () => {
    store.set("s1", startGoalState(defaultState(), "fix-tests")); // viaScheduler defaults to undefined
    const enqueue = vi.fn(() => "queued" as const);
    const broadcast = vi.fn(async () => {});
    const deps90 = {
      config: { autopilot: { ...autopilotCfg, usagePausePct: 90 } },
      bridge: {
        capturePane: async () => "",
        sendRawKey: vi.fn(async () => {}),
        sendKeys: vi.fn(async () => {}),
      },
      queue: { size: () => 0, isSessionProcessing: () => false, enqueue },
      notifier: { broadcast },
      configResolver: { detectAgentKind: async () => null },
    } as never;
    const readUsage = vi.fn(async () => ({
      sessionId: "s",
      contextPct: null,
      fiveHourPct: 95,
      fiveHourReset: null,
      sevenDayPct: null,
      sevenDayReset: null,
      updatedAt: Date.now() / 1000,
    }));
    const action = await runSupervisorTick(deps90, store, "s1", 1_000_000, {
      ...probes,
      readUsage,
    });
    expect(action.kind).toBe("pauseNotify");
    expect(store.get("s1").enabled).toBe(false);
  });
});
