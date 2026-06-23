import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tickAllEnabled } from "../../src/core/autopilot/manager.js";
import { AutopilotStore } from "../../src/core/autopilot/state-store.js";
import { defaultState } from "../../src/core/autopilot/types.js";

const PREFIX = "tmux_proj_";
const OPERATOR = "tmux_proj_home";
const REAL_PROJECT = "tmux_proj_myapp";

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
  dir = mkdtempSync(join(tmpdir(), "tcb-mgr-op-"));
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
    config: { autopilot: autopilotCfg, projectSessionPrefix: PREFIX },
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

describe("tickAllEnabled — operator exclusion", () => {
  it("global keep-alive does NOT auto-enroll the operator session", async () => {
    process.env.AUTOPILOT_GLOBAL_KEEPALIVE = "1";
    await tickAllEnabled(deps([OPERATOR, REAL_PROJECT]), store, 1_000_000);

    // Operator must remain pristine (not enrolled)
    expect(store.get(OPERATOR).enabled).toBe(false);
    expect(store.get(OPERATOR).startedAt).toBeUndefined();

    // Real project should be enrolled
    expect(store.get(REAL_PROJECT).enabled).toBe(true);
  });

  it("operator is NOT ticked even if somehow already in the store as enabled", async () => {
    // Manually seed the operator as enabled (simulates a corrupted/legacy state)
    store.set(OPERATOR, { ...defaultState(), enabled: true, pureKeepAlive: true });
    const d = deps([OPERATOR, REAL_PROJECT]);
    await tickAllEnabled(d, store, 1_000_000);

    // The operator must be cleared (filtered out of live → dead-session self-heal)
    expect(store.get(OPERATOR).enabled).toBe(false);
    // The enqueue should NOT have been called for the operator
    const enqueue = (d as never as { queue: { enqueue: ReturnType<typeof vi.fn> } }).queue.enqueue;
    // Any enqueue calls must target REAL_PROJECT, never OPERATOR
    for (const call of enqueue.mock.calls) {
      const msg = call[0] as { sessionName: string };
      expect(msg.sessionName).not.toBe(OPERATOR);
    }
  });

  it("real project alongside operator is still processed normally", async () => {
    store.set(REAL_PROJECT, { ...defaultState(), enabled: true, pureKeepAlive: true });
    const d = deps([OPERATOR, REAL_PROJECT]);
    await tickAllEnabled(d, store, 1_000_000);

    const enqueue = (d as never as { queue: { enqueue: ReturnType<typeof vi.fn> } }).queue.enqueue;
    expect(enqueue).toHaveBeenCalled();
    expect(
      (enqueue.mock.calls as Array<[{ sessionName: string }]>).some(
        ([m]) => m.sessionName === REAL_PROJECT,
      ),
    ).toBe(true);
  });
});
