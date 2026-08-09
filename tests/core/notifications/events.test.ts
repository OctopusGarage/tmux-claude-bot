import { describe, expect, it } from "vitest";
import { notificationRequestForEvent } from "../../../src/core/notifications/events.js";

describe("notification event contracts", () => {
  it("renders resource sampling degradation separately from pressure transitions", () => {
    const request = notificationRequestForEvent({
      kind: "resource.sampling-degraded",
      phase: "sampling-failed",
      incidentId: "resource-43",
      error: "probe unavailable",
      consecutiveFailures: 2,
      circuit: "background-closed",
    });

    expect(request).toMatchObject({
      level: "warning",
      source: "resource-guardian",
      title: "Resource sampling degraded",
    });
    expect(request.body).toContain("phase: sampling-failed");
    expect(request.body).toContain("incident: resource-43");
    expect(request.body).toContain("failures: 2");
    expect(request.body).toContain("circuit: background-closed");
    expect(request.body).toContain("error: probe unavailable");
  });

  it("renders resource pressure transitions with shared channel semantics", () => {
    const request = notificationRequestForEvent({
      kind: "resource.pressure-transition",
      oldState: "elevated",
      newState: "critical",
      incidentId: "resource-42",
      hostCpuPct: 94.25,
      circuit: "background-closed",
      actionSummary: "protect mode closed background admission",
    });

    expect(request).toMatchObject({
      level: "warning",
      source: "resource-guardian",
      title: "Resource pressure: elevated → critical",
    });
    expect(request.body).toContain("incident: resource-42");
    expect(request.body).toContain("host CPU: 94.25%");
    expect(request.body).toContain("circuit: background-closed");
    expect(request.body).toContain("action: protect mode closed background admission");
  });

  it("renders resource action failures without pretending they are pressure transitions", () => {
    const request = notificationRequestForEvent({
      kind: "resource.action-failed",
      incidentId: "resource-44",
      circuit: "background-closed",
      reason: "TERM rejected",
    });

    expect(request).toMatchObject({
      level: "error",
      source: "resource-guardian",
      title: "Resource action failed",
    });
    expect(request.body).toContain("incident: resource-44");
    expect(request.body).toContain("reason: TERM rejected");
  });

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
