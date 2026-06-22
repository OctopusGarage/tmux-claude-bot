import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAutopilotView } from "../../src/core/autopilot/autopilot-view.js";
import { startCycleState } from "../../src/core/autopilot/goals/goal-state.js";
import { clearPicker, toggleGoal } from "../../src/core/autopilot/picker-state.js";
import { AutopilotStore } from "../../src/core/autopilot/state-store.js";
import { defaultState } from "../../src/core/autopilot/types.js";
import { en } from "../../src/core/i18n/catalog/en.js";

describe("buildAutopilotView", () => {
  let dir: string;
  let store: AutopilotStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tcb-apv-"));
    process.env.TCB_STATE_DIR = dir;
    store = new AutopilotStore();
    clearPicker("s1");
  });
  afterEach(() => {
    delete process.env.TCB_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("off session → mode off, all goals unselected", () => {
    const v = buildAutopilotView(store, "s1", en);
    expect(v.enabled).toBe(false);
    expect(v.mode).toBe("off");
    expect(v.goals.length).toBeGreaterThan(0);
    expect(v.goals.every((g) => !g.selected)).toBe(true);
  });

  it("active cycle → mode cycle with position", () => {
    store.set("s1", startCycleState(defaultState(), ["fix-tests", "code-review"], 2));
    const v = buildAutopilotView(store, "s1", en);
    expect(v.mode).toBe("cycle");
    expect(v.cycle).toMatchObject({ goalId: "fix-tests", pos: 1, total: 2, round: 1, rounds: 2 });
  });

  it("enabled with no goal → mode keepalive, no cycle block", () => {
    store.set("s1", { ...defaultState(), enabled: true, pureKeepAlive: true });
    const v = buildAutopilotView(store, "s1", en);
    expect(v.mode).toBe("keepalive");
    expect(v.cycle).toBeUndefined();
  });

  it("picker selection reflected in goals[].selected", () => {
    toggleGoal("s1", "fix-tests");
    const v = buildAutopilotView(store, "s1", en);
    expect(v.goals.find((g) => g.id === "fix-tests")?.selected).toBe(true);
  });
});
