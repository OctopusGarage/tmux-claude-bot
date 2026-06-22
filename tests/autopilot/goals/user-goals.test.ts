import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadUserGoals } from "../../../src/core/autopilot/goals/user-goals.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tcb-goals-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadUserGoals", () => {
  it("loads valid json goals, skips invalid + non-json", () => {
    writeFileSync(
      join(dir, "good.json"),
      JSON.stringify({
        id: "ug",
        titleKey: "UG",
        phases: [
          {
            id: "p",
            intent: { kind: "prompt", text: "go" },
            done: { kind: "sentinel", marker: "D" },
          },
        ],
      }),
    );
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ id: "x" }));
    writeFileSync(join(dir, "note.txt"), "ignore me");
    const goals = loadUserGoals(dir);
    expect(goals.map((g) => g.id)).toEqual(["ug"]);
  });
  it("returns [] for a missing dir", () => {
    expect(loadUserGoals(join(dir, "nope"))).toEqual([]);
  });
});
