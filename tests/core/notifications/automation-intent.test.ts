import { describe, expect, it } from "vitest";
import { buildAutomationNotificationIntent } from "../../../src/core/notifications/automation-intent.js";

describe("automation notification intent", () => {
  it("builds a channel-neutral attention intent from automation facts", () => {
    expect(
      buildAutomationNotificationIntent({
        title: "Daily task audit · 2026-08-08 SGT",
        status: "attention",
        summary: ["Counts: 1 failed", "Repair: 1 candidate · queued"],
        issues: ["Daily scheduled task audit · failed · timeout"],
      }),
    ).toEqual({
      level: "warning",
      title: "Daily task audit · 2026-08-08 SGT",
      sections: [
        { kind: "summary", lines: ["Counts: 1 failed", "Repair: 1 candidate · queued"] },
        { kind: "issues", lines: ["Daily scheduled task audit · failed · timeout"] },
      ],
    });
  });
});
