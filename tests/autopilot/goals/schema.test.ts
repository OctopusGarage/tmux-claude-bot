import { describe, expect, it } from "vitest";
import { parseGoal } from "../../../src/core/autopilot/goals/schema.js";

const valid = {
  id: "my-goal",
  titleKey: "My Goal",
  phases: [
    {
      id: "p1",
      intent: { kind: "prompt", text: "do it" },
      done: { kind: "sentinel", marker: "DONE" },
    },
  ],
};

describe("parseGoal", () => {
  it("accepts a valid goal", () => {
    const r = parseGoal(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal.id).toBe("my-goal");
  });
  it("accepts composable done (all/seq) and skill intent", () => {
    const g = {
      id: "g2",
      titleKey: "G2",
      phases: [
        {
          id: "p",
          intent: { kind: "skill", name: "x", fallback: "fb" },
          done: { kind: "seq", of: [{ kind: "sentinel", marker: "A" }, { kind: "humanGate" }] },
        },
      ],
    };
    expect(parseGoal(g).ok).toBe(true);
  });
  it("rejects a malformed goal with an error message", () => {
    expect(parseGoal({ id: "x" }).ok).toBe(false);
    expect(parseGoal({ id: "x", titleKey: "X", phases: [] }).ok).toBe(false); // empty phases
    const bad = parseGoal({
      id: "x",
      titleKey: "X",
      phases: [{ id: "p", intent: { kind: "nope" }, done: { kind: "sentinel", marker: "D" } }],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(typeof bad.error).toBe("string");
  });
});
