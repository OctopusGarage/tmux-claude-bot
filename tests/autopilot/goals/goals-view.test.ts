import { describe, expect, it } from "vitest";
import { formatGoalsList } from "../../../src/core/autopilot/goals/goals-view.js";
import { messages } from "../../../src/core/i18n/index.js";

describe("formatGoalsList", () => {
  it("contains the goals title", () => {
    const result = formatGoalsList(messages("telegram"));
    expect(result).toContain(messages("telegram").goalsTitle);
  });

  it("contains every goal id", () => {
    const result = formatGoalsList(messages("telegram"));
    const ids = [
      "fix-tests",
      "test-coverage",
      "code-review",
      "add-feature",
      "refactor-elegant",
      "ui-polish",
    ];
    for (const id of ids) {
      expect(result).toContain(id);
    }
  });

  it("contains at least one localized zh title", () => {
    // Use zh messages directly to check localization
    const result = formatGoalsList(messages("telegram"));
    // zh locale titles (messages("telegram") resolves to zh by default in tests)
    // "修复测试" is the zh title for goalFixTests
    expect(result).toContain("修复测试");
  });
});
