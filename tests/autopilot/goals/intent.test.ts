import { describe, expect, it } from "vitest";
import { intentToText } from "../../../src/core/autopilot/goals/intent.js";

describe("intentToText", () => {
  it("prompt → its text", () => {
    expect(intentToText({ kind: "prompt", text: "go" }, "claude")).toBe("go");
  });
  it("skill → /name on claude, fallback on codex", () => {
    const skill = { kind: "skill", name: "code-review", fallback: "review please" } as const;
    expect(intentToText(skill, "claude")).toBe("/code-review");
    expect(intentToText(skill, "codex")).toBe("review please");
  });
});
