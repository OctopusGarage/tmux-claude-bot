import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutopilotStore, clearAutopilotState } from "../../src/core/autopilot/state-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tcb-autopilot-"));
  process.env.TCB_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("AutopilotStore", () => {
  it("returns a disabled default for an unknown session", () => {
    const store = new AutopilotStore();
    expect(store.get("s1").enabled).toBe(false);
  });

  it("persists, lists enabled sessions, and clears", () => {
    const store = new AutopilotStore();
    store.set("s1", { ...store.get("s1"), enabled: true });
    store.set("s2", { ...store.get("s2"), enabled: false });
    expect(store.enabledSessions()).toEqual(["s1"]);
    // survives a fresh instance (file-backed)
    expect(new AutopilotStore().get("s1").enabled).toBe(true);
    store.clear("s1");
    expect(store.enabledSessions()).toEqual([]);
  });

  it("clearAutopilotState removes a session's record (project-removal cleanup)", () => {
    const store = new AutopilotStore();
    // an opted-out/stopped record the sweep would NOT self-heal (it only clears enabled ones)
    store.set("s1", { ...store.get("s1"), enabled: false, optOut: true, goalId: "fix-tests" });
    clearAutopilotState("s1");
    const after = store.get("s1");
    expect(after.optOut).toBeUndefined();
    expect(after.goalId).toBeUndefined(); // back to defaultState — a reused slot is clean
  });

  it("clearPendingContextOps strips the flag and keeps all other fields; untouched sessions are unaffected", () => {
    const store = new AutopilotStore();
    store.set("s1", {
      ...store.get("s1"),
      enabled: true,
      goalId: "fix-tests",
      pendingContextOp: "compact" as const,
    });
    store.set("s2", { ...store.get("s2"), enabled: true, goalId: "code-review" }); // no flag
    store.clearPendingContextOps();
    const s1 = store.get("s1");
    expect(s1.pendingContextOp).toBeUndefined(); // flag cleared
    expect(s1.enabled).toBe(true); // other fields intact
    expect(s1.goalId).toBe("fix-tests");
    const s2 = store.get("s2");
    expect(s2.goalId).toBe("code-review"); // untouched session unaffected
    expect(s2.pendingContextOp).toBeUndefined();
  });
});
