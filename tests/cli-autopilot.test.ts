import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAutopilotSnapshot,
  formatAutopilotText,
} from "../src/core/autopilot/autopilot-snapshot.js";
import { startGoalState } from "../src/core/autopilot/goals/goal-state.js";
import { AutopilotStore } from "../src/core/autopilot/state-store.js";
import { defaultState } from "../src/core/autopilot/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tcb-autopilot-snap-"));
  process.env.TCB_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function fakeDeps(liveSessions: string[] = []) {
  return {
    bridge: { listProjectSessions: async () => liveSessions },
  } as never;
}

describe("buildAutopilotSnapshot", () => {
  it("returns an empty snapshot when there are no live or recorded sessions", async () => {
    const snap = await buildAutopilotSnapshot(fakeDeps([]));
    expect(snap.sessions).toHaveLength(0);
    expect(snap.generatedAt).toBeGreaterThan(0);
  });

  it("includes live sessions even when not in the store", async () => {
    const snap = await buildAutopilotSnapshot(fakeDeps(["sess_a", "sess_b"]));
    expect(snap.sessions.map((s) => s.session)).toEqual(["sess_a", "sess_b"]);
    expect(snap.sessions[0]?.enabled).toBe(false); // default: not enabled
  });

  it("includes recorded enabled sessions not present in live list", async () => {
    // Write an enabled session to the store that is NOT in the live list.
    const store = new AutopilotStore();
    store.set("sess_recorded", {
      enabled: true,
      pureKeepAlive: false,
      persona: "conservative",
      iterations: 5,
      apiRetries: 0,
      recoveries: 0,
    });

    const snap = await buildAutopilotSnapshot(fakeDeps([])); // no live sessions
    expect(snap.sessions.map((s) => s.session)).toContain("sess_recorded");
    const rec = snap.sessions.find((s) => s.session === "sess_recorded");
    expect(rec?.enabled).toBe(true);
    expect(rec?.iterations).toBe(5);
  });

  it("unions live and recorded sessions without duplicates", async () => {
    const store = new AutopilotStore();
    store.set("sess_a", {
      enabled: true,
      pureKeepAlive: true,
      persona: "conservative",
      iterations: 2,
      apiRetries: 0,
      recoveries: 0,
    });
    // sess_a is in both live and recorded; sess_b only live; sess_c only recorded.
    store.set("sess_c", {
      enabled: true,
      pureKeepAlive: false,
      persona: "conservative",
      iterations: 1,
      apiRetries: 0,
      recoveries: 0,
    });

    const snap = await buildAutopilotSnapshot(fakeDeps(["sess_a", "sess_b"]));
    const names = snap.sessions.map((s) => s.session);
    expect(names).toContain("sess_a");
    expect(names).toContain("sess_b");
    expect(names).toContain("sess_c");
    // No duplicates.
    expect(names.length).toBe(new Set(names).size);
  });

  it("degrades gracefully when listProjectSessions throws", async () => {
    const store = new AutopilotStore();
    store.set("sess_only_recorded", {
      enabled: true,
      pureKeepAlive: false,
      persona: "conservative",
      iterations: 0,
      apiRetries: 0,
      recoveries: 0,
    });
    const brokenDeps = {
      bridge: {
        listProjectSessions: async () => {
          throw new Error("tmux gone");
        },
      },
    } as never;
    const snap = await buildAutopilotSnapshot(brokenDeps);
    expect(snap.sessions.map((s) => s.session)).toContain("sess_only_recorded");
  });

  it("includes goalId and phaseIndex in snapshot when a goal is active", async () => {
    const store = new AutopilotStore();
    store.set("sess_goal", startGoalState(defaultState(), "fix-tests"));

    const snap = await buildAutopilotSnapshot(fakeDeps(["sess_goal"]));
    const entry = snap.sessions.find((s) => s.session === "sess_goal");
    expect(entry?.goalId).toBe("fix-tests");
    expect(entry?.phaseIndex).toBe(0);
  });
});

describe("formatAutopilotText", () => {
  it("shows 0 enabled when all sessions are disabled", () => {
    const snap = {
      sessions: [
        { session: "s1", label: "proj-1", enabled: false, pureKeepAlive: false, iterations: 0 },
      ],
      generatedAt: 0,
    };
    const out = formatAutopilotText(snap);
    expect(out).toContain("0 enabled / 1 sessions");
    expect(out).toContain("⚪ proj-1");
    expect(out).toContain("goal-driven");
  });

  it("shows correct counts and tags for enabled sessions", () => {
    const snap = {
      sessions: [
        { session: "s1", label: "proj-1", enabled: true, pureKeepAlive: true, iterations: 7 },
        { session: "s2", label: "proj-2", enabled: false, pureKeepAlive: false, iterations: 0 },
      ],
      generatedAt: 0,
    };
    const out = formatAutopilotText(snap);
    expect(out).toContain("1 enabled / 2 sessions");
    expect(out).toContain("🟢 proj-1");
    expect(out).toContain("keep-alive");
    expect(out).toContain("7 interventions");
    expect(out).toContain("⚪ proj-2");
  });

  it("returns header only for an empty snapshot", () => {
    const snap = { sessions: [], generatedAt: 0 };
    const out = formatAutopilotText(snap);
    expect(out).toBe("✈️ autopilot · 0 enabled / 0 sessions");
  });

  it("shows goal id and 🎯 marker for a goal-active session", () => {
    const snap = {
      sessions: [
        {
          session: "s1",
          label: "my-proj",
          enabled: true,
          pureKeepAlive: false,
          iterations: 3,
          goalId: "fix-tests",
          phaseIndex: 0,
        },
      ],
      generatedAt: 0,
    };
    const out = formatAutopilotText(snap);
    expect(out).toContain("fix-tests");
    expect(out).toContain("🎯");
    expect(out).toContain("fix-tests#0");
  });
});
