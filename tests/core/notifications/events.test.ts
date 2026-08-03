import { describe, expect, it } from "vitest";
import { notificationRequestForEvent } from "../../../src/core/notifications/events.js";

describe("notification event contracts", () => {
  it("renders long task completion with task identity and latest assistant evidence", () => {
    const request = notificationRequestForEvent({
      kind: "long-task.finished",
      session: "tmux_proj_api",
      label: "api",
      status: "completed",
      durationMs: 9 * 60 * 1000 + 18_000,
      latestHistory: "Implemented the API guard and ran focused tests.",
    });

    expect(request).toMatchObject({
      level: "success",
      source: "long-task-monitor",
      session: "tmux_proj_api",
      title: "Long task finished: api",
    });
    expect(request.body).toContain("duration: 9m 18s");
    expect(request.body).toContain("latest history:");
    expect(request.body).toContain("Implemented the API guard");
  });

  it("truncates noisy long task history in the event renderer", () => {
    const request = notificationRequestForEvent({
      kind: "long-task.finished",
      session: "tmux_proj_api",
      label: "api",
      status: "completed",
      durationMs: 60_000,
      latestHistory: "x".repeat(2_000),
    });

    const body = request.body ?? "";
    expect(body).toContain("[truncated]");
    expect(body.length).toBeLessThan(2_000);
  });
});
