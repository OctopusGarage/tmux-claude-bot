import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tickAllEnabled } from "../../src/core/autopilot/manager.js";
import { AutopilotStore } from "../../src/core/autopilot/state-store.js";
import { defaultState } from "../../src/core/autopilot/types.js";

const autopilotCfg = {
  tickMs: 8000,
  idleGraceMs: 20000,
  cooldownMs: 30000,
  maxIterations: 30,
  maxWallClockMs: 3600000,
  idlePromptText: "继续",
  apiErrorPromptText: "重试",
  maxRecoveryAttempts: 5,
  retry: { maxRetries: 5, baseDelayMs: 5000, backoffFactor: 2, maxDelayMs: 120000, jitter: false },
  goalsDir: "",
  usagePausePct: 0,
};

let dir: string;
let store: AutopilotStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tcb-mgr-"));
  process.env.TCB_STATE_DIR = dir;
  delete process.env.AUTOPILOT_GLOBAL_KEEPALIVE;
  store = new AutopilotStore();
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  delete process.env.AUTOPILOT_GLOBAL_KEEPALIVE;
  rmSync(dir, { recursive: true, force: true });
});

function deps(liveSessions: string[]) {
  const enqueue = vi.fn(() => "queued" as const);
  return {
    config: { autopilot: autopilotCfg },
    bridge: {
      listProjectSessions: async () => liveSessions,
      capturePane: async () => "",
      sendRawKey: vi.fn(async () => {}),
      sendKeys: vi.fn(async () => {}),
    },
    queue: { size: () => 0, isSessionProcessing: () => false, enqueue },
    notifier: { broadcast: vi.fn(async () => {}) },
    configResolver: { detectAgentKind: async () => "claude" },
  } as never;
}

describe("tickAllEnabled", () => {
  it("clears records for enabled sessions that are no longer live (self-heal)", async () => {
    store.set("dead", { ...defaultState(), enabled: true, pureKeepAlive: true });
    await tickAllEnabled(deps([]), store, 1_000_000);
    expect(store.get("dead").enabled).toBe(false);
    expect(store.enabledSessions()).toEqual([]);
  });

  it("ticks a live enabled session (enqueues a nudge)", async () => {
    store.set("s1", { ...defaultState(), enabled: true, pureKeepAlive: true });
    const d = deps(["s1"]);
    await tickAllEnabled(d, store, 1_000_000);
    expect(
      (d as never as { queue: { enqueue: ReturnType<typeof vi.fn> } }).queue.enqueue,
    ).toHaveBeenCalled();
  });

  it("global off + no enabled sessions → returns early without listing sessions", async () => {
    const d = deps([]);
    const list = vi.spyOn(
      (d as never as { bridge: { listProjectSessions: () => Promise<string[]> } }).bridge,
      "listProjectSessions",
    );
    await tickAllEnabled(d, store, 1_000_000); // store has no enabled sessions
    expect(list).not.toHaveBeenCalled();
  });

  it("a listProjectSessions failure is swallowed (no throw, no spurious clear)", async () => {
    store.set("s1", { ...defaultState(), enabled: true, pureKeepAlive: true });
    const d = deps([]);
    (
      d as never as { bridge: { listProjectSessions: () => Promise<string[]> } }
    ).bridge.listProjectSessions = async () => {
      throw new Error("tmux down");
    };
    await expect(tickAllEnabled(d, store, 1_000_000)).resolves.toBeUndefined();
    expect(store.get("s1").enabled).toBe(true); // bailed before the self-heal, not cleared
  });
});

describe("tickAllEnabled — global keep-alive", () => {
  it("enrolls a pristine live session as keep-alive", async () => {
    process.env.AUTOPILOT_GLOBAL_KEEPALIVE = "1";
    await tickAllEnabled(deps(["s1"]), store, 1_000_000);
    const st = store.get("s1");
    expect(st.enabled).toBe(true);
    expect(st.pureKeepAlive).toBe(true);
    expect(st.viaGlobal).toBe(true);
  });

  it("does NOT enroll an opted-out session", async () => {
    process.env.AUTOPILOT_GLOBAL_KEEPALIVE = "1";
    store.set("s1", { ...defaultState(), optOut: true });
    await tickAllEnabled(deps(["s1"]), store, 1_000_000);
    expect(store.get("s1").enabled).toBe(false);
  });

  it("does NOT enroll an already-managed session (startedAt set) or a goal session", async () => {
    process.env.AUTOPILOT_GLOBAL_KEEPALIVE = "1";
    store.set("managed", { ...defaultState(), startedAt: 123 }); // ran before, stopped
    store.set("goalful", { ...defaultState(), goalId: "fix-tests" });
    await tickAllEnabled(deps(["managed", "goalful"]), store, 1_000_000);
    expect(store.get("managed").enabled).toBe(false);
    expect(store.get("goalful").enabled).toBe(false);
  });

  it("un-enrolls a globally-enrolled session when global is turned off", async () => {
    // global off (env unset); a session previously auto-enrolled via global
    store.set("s1", { ...defaultState(), enabled: true, pureKeepAlive: true, viaGlobal: true });
    await tickAllEnabled(deps(["s1"]), store, 1_000_000);
    const st = store.get("s1");
    expect(st.enabled).toBe(false);
    expect(st.viaGlobal).toBe(false);
  });
});
