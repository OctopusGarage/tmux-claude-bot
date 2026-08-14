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

    expect(request).toBeNull();
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
      title: "Resource pressure critical",
    });
    if (request === null) throw new Error("expected actionable transition");
    expect(request.body).toBe("CPU 94.25% · background work paused");
    expect(request.delivery).toEqual({
      mode: "state-change",
      topic: "resource-guardian:pressure",
      state: "critical",
    });
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
    if (request === null) throw new Error("expected actionable failure");
    expect(request.body).toBe("TERM rejected · check tcb resource status");
  });

  it("keeps elevated pressure as status evidence instead of a notification", () => {
    expect(
      notificationRequestForEvent({
        kind: "resource.pressure-transition",
        oldState: "healthy",
        newState: "elevated",
        incidentId: "resource-41",
        hostCpuPct: 82,
        circuit: "open",
        actionSummary: "observing",
      }),
    ).toBeNull();
  });

  it("only emits healthy recovery through stateful pairing", () => {
    const request = notificationRequestForEvent({
      kind: "resource.pressure-transition",
      oldState: "critical",
      newState: "healthy",
      incidentId: "resource-42",
      hostCpuPct: 25,
      circuit: "open",
      actionSummary: "background admission restored",
    });
    expect(request).toMatchObject({
      title: "Resource pressure recovered",
      delivery: {
        mode: "state-change",
        topic: "resource-guardian:pressure",
        state: "healthy",
        notifyInitial: false,
      },
    });
    if (request === null) throw new Error("expected recovery transition");
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
    if (request === null) throw new Error("expected long-task result");
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

    if (request === null) throw new Error("expected long-task result");
    const body = request.body ?? "";
    expect(body).toContain("[truncated]");
    expect(body.length).toBeLessThan(900);
  });
});
