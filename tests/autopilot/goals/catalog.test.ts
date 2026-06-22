import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGoal, listGoals } from "../../../src/core/autopilot/goals/catalog.js";

describe("goal catalog", () => {
  it("exposes the six built-in goals, each with at least one phase and a done condition", () => {
    const goals = listGoals();
    const ids = goals.map((g) => g.id).sort();
    expect(ids).toEqual(
      [
        "add-feature",
        "code-review",
        "fix-tests",
        "refactor-elegant",
        "test-coverage",
        "ui-polish",
      ].sort(),
    );
    for (const g of goals) {
      expect(g.phases.length).toBeGreaterThan(0);
      for (const p of g.phases) expect(p.done).toBeTruthy();
    }
  });

  it("getGoal resolves by id and returns undefined for unknown", () => {
    expect(getGoal("fix-tests")?.id).toBe("fix-tests");
    expect(getGoal("nope")).toBeUndefined();
  });
});

const ugJson = JSON.stringify({
  id: "ug",
  titleKey: "userGoalUg",
  phases: [
    {
      id: "do-it",
      intent: { kind: "prompt", text: "Do the thing." },
      done: { kind: "sentinel", marker: "GOAL_DONE" },
    },
  ],
});

const fixTestsOverrideJson = JSON.stringify({
  id: "fix-tests",
  titleKey: "userOverrideShouldBeIgnored",
  phases: [
    {
      id: "override",
      intent: { kind: "prompt", text: "Override." },
      done: { kind: "sentinel", marker: "GOAL_DONE" },
    },
  ],
});

describe("goal catalog — user goals", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tcb-goals-test-"));
    process.env.AUTOPILOT_GOALS_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.AUTOPILOT_GOALS_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes a valid user goal alongside all six built-ins", () => {
    writeFileSync(join(tmpDir, "ug.json"), ugJson);
    const ids = listGoals()
      .map((g) => g.id)
      .sort();
    expect(ids).toEqual(
      [
        "add-feature",
        "code-review",
        "fix-tests",
        "refactor-elegant",
        "test-coverage",
        "ug",
        "ui-polish",
      ].sort(),
    );
    expect(getGoal("ug")?.id).toBe("ug");
  });

  it("built-in wins when user goal id collides with a built-in", () => {
    writeFileSync(join(tmpDir, "fix-tests-override.json"), fixTestsOverrideJson);
    const goal = getGoal("fix-tests");
    expect(goal?.titleKey).toBe("goalFixTests");
    const ids = listGoals().map((g) => g.id);
    expect(ids.filter((id) => id === "fix-tests")).toHaveLength(1);
  });
});
