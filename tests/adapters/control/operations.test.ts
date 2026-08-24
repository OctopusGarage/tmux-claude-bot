import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  controlOperationNames,
  createControlOperationHandlers,
  handleControlRequest,
} from "../../../src/adapters/control/operations.js";
import { createControlDiagnosticsHandlers } from "../../../src/adapters/control/operations-diagnostics.js";
import {
  createControlObservationHandlers,
  readDailyTaskAuditObservation,
} from "../../../src/adapters/control/operations-observation.js";
import { createControlProjectSessionHandlers } from "../../../src/adapters/control/operations-project-sessions.js";
import type { ControlRequest } from "../../../src/adapters/control/protocol.js";
import type { HandlerDeps } from "../../../src/core/deps.js";
import type { ScheduledTaskRecord } from "../../../src/core/tasks/task-ledger.js";
import { currentLogContext } from "../../../src/shared/utils/log-context.js";

describe("control operation registry", () => {
  it("groups dashboard and diagnostic reads behind one handler family", () => {
    const handlers = createControlDiagnosticsHandlers({} as HandlerDeps);

    expect(Object.keys(handlers).sort()).toEqual([
      "inputs",
      "logs",
      "peek",
      "promptTranslate",
      "snapshot",
      "sysload",
    ]);
  });

  it("groups bounded automation evidence behind one read-only handler family", () => {
    const handlers = createControlObservationHandlers({} as HandlerDeps);

    expect(Object.keys(handlers).sort()).toEqual([
      "dailyTaskAuditStatus",
      "loopReports",
      "runtimeGuardianFindings",
    ]);
  });

  it("keeps Runtime Guardian read-only observations on the pure inspector path", () => {
    const source = readFileSync("src/adapters/control/operations-observation.ts", "utf8");

    expect(source).toContain('from "../../core/runtime-guardian/inspector.js"');
    expect(source).not.toContain('from "../../core/runtime-guardian/service.js"');
  });

  it("reports explicit Daily Task Audit truncation", () => {
    const now = Date.parse("2026-08-12T12:00:00+08:00");
    const records = Array.from(
      { length: 52 },
      (_, index): ScheduledTaskRecord => ({
        taskId: `task-${index}`,
        source: "daily-audit",
        name: `Task ${index}`,
        scheduledAt: now - index * 1_000,
        status: "success",
        endedAt: now - index * 1_000 + 10,
        updatedAt: now - index * 1_000 + 10,
      }),
    );

    const view = readDailyTaskAuditObservation({
      now,
      ledger: { listForWindow: () => records },
      auditStore: { getLastFired: () => now - 1_000 },
    });

    expect(view).toMatchObject({
      recentLimit: 50,
      recentTotal: 52,
      recentTruncated: true,
    });
    expect(view.recentRecords).toHaveLength(50);
  });

  it("validates and bounds Runtime Guardian observation at the Control boundary", async () => {
    const ok = vi.fn();
    const findings = [
      {
        kind: "missing-system-gate" as const,
        severity: "medium" as const,
        runId: "run-3",
        projectId: "project",
        projectPath: "/synthetic/project",
        evidence: ["missing gate"],
      },
      {
        kind: "stale-dispatching-work-order" as const,
        severity: "high" as const,
        runId: "run-1",
        projectId: "project",
        projectPath: "/synthetic/project",
        evidence: ["stale dispatch"],
      },
      {
        kind: "terminal-work-order-active-lease" as const,
        severity: "high" as const,
        runId: "run-2",
        projectId: "project",
        projectPath: "/synthetic/project",
        evidence: ["active lease"],
      },
    ];
    const handlers = createControlObservationHandlers(
      { config: { runtimeGuardian: { repoPath: "" } } } as HandlerDeps,
      { runtimeGuardianFindings: () => findings },
    );

    await handlers.runtimeGuardianFindings(
      { id: 1, op: "runtimeGuardianFindings", now: 100, lookbackHours: 999, limit: 2 },
      {
        ok,
        fail: vi.fn(),
        send: vi.fn(),
        isOperatorHomeCaller: false,
      },
    );

    expect(ok).toHaveBeenCalledWith({
      observedAt: 100,
      lookbackHours: 168,
      findings: [findings[1], findings[2]],
      total: 3,
      limit: 2,
      truncated: true,
    });
  });

  it("filters Runtime Guardian findings by project before applying the result limit", async () => {
    const ok = vi.fn();
    const findings = [
      {
        kind: "terminal-invalid-output" as const,
        severity: "high" as const,
        runId: "beta-run",
        projectId: "beta",
        projectPath: "/synthetic/beta",
        evidence: [],
      },
      {
        kind: "missing-system-gate" as const,
        severity: "medium" as const,
        runId: "alpha-run",
        projectId: "alpha",
        projectPath: "/synthetic/alpha",
        evidence: [],
      },
    ];
    const handlers = createControlObservationHandlers(
      { config: { runtimeGuardian: { repoPath: "" } } } as HandlerDeps,
      { runtimeGuardianFindings: () => findings },
    );

    await handlers.runtimeGuardianFindings(
      { id: 1, op: "runtimeGuardianFindings", now: 100, projectId: "alpha", limit: 20 },
      {
        ok,
        fail: vi.fn(),
        send: vi.fn(),
        isOperatorHomeCaller: false,
      },
    );

    expect(ok).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 1,
        findings: [expect.objectContaining({ projectId: "alpha", runId: "alpha-run" })],
      }),
    );
  });

  it("groups Project Session lifecycle operations behind one handler family", () => {
    const handlers = createControlProjectSessionHandlers({} as HandlerDeps);

    expect(Object.keys(handlers).sort()).toEqual([
      "adopt",
      "open",
      "openPath",
      "openWorker",
      "orphans",
      "projects",
      "recover",
    ]);
  });

  it("exposes one explicit handler per protocol operation", () => {
    const handlers = createControlOperationHandlers({} as HandlerDeps, () => {});

    expect(Object.keys(handlers).sort()).toEqual([...controlOperationNames].sort());
    expect(controlOperationNames).toEqual([
      "snapshot",
      "peek",
      "send",
      "control",
      "projects",
      "open",
      "openPath",
      "openWorker",
      "orphans",
      "adopt",
      "recover",
      "logs",
      "sysload",
      "inputs",
      "promptTranslate",
      "taskAudit",
      "loopReports",
      "dailyTaskAuditStatus",
      "runtimeGuardianFindings",
      "notify",
      "autopilot",
      "sendAttachment",
    ]);
  });

  it("keeps error framing in the shared request wrapper", async () => {
    const send = vi.fn();
    const req = { id: 99, op: "snapshot" } satisfies ControlRequest;

    await handleControlRequest({} as HandlerDeps, req, send, {
      ...createControlOperationHandlers({} as HandlerDeps, send),
      snapshot: async () => {
        throw new Error("boom");
      },
    });

    expect(send).toHaveBeenCalledWith({ id: 99, ok: false, error: "boom" });
  });

  it("passes caller provenance and Home Operator workspace classification to handlers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-home-caller-"));
    const send = vi.fn();
    const deps = {
      config: { homeOperator: { dir } },
    } as HandlerDeps;
    const req = {
      id: 100,
      op: "snapshot",
      caller: { source: "control-client", cwd: dir, pid: 123 },
    } satisfies ControlRequest;

    try {
      await handleControlRequest(deps, req, send, {
        ...createControlOperationHandlers(deps, send),
        snapshot: async (_req, ctx) => {
          ctx.ok({
            caller: ctx.caller,
            isOperatorHomeCaller: ctx.isOperatorHomeCaller,
          });
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(send).toHaveBeenCalledWith({
      id: 100,
      ok: true,
      data: {
        caller: { source: "control-client", cwd: dir, pid: 123 },
        isOperatorHomeCaller: true,
      },
    });
  });

  it("establishes a fresh trace and session context for each Control request", async () => {
    const send = vi.fn();
    const req = { id: 101, op: "peek", session: "worker-a", lines: 10 } satisfies ControlRequest;
    let observed = {};

    await handleControlRequest({} as HandlerDeps, req, send, {
      ...createControlOperationHandlers({} as HandlerDeps, send),
      peek: async (_req, ctx) => {
        observed = currentLogContext();
        ctx.ok("done");
      },
    });

    expect(observed).toMatchObject({ session: "worker-a" });
    expect(observed).toHaveProperty("traceId", expect.stringMatching(/^t_[a-f0-9]{8}$/));
    expect(currentLogContext()).toEqual({});
  });

  it("carries the Control request trace into queued prompt execution", async () => {
    const enqueue = vi.fn(() => "queued" as const);
    const send = vi.fn();
    const deps = {
      config: { projectSessionPrefix: "tmux_" },
      queue: { enqueue },
    } as unknown as HandlerDeps;

    await handleControlRequest(
      deps,
      { id: 102, op: "send", session: "worker-a", text: "hello" },
      send,
    );

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: "worker-a",
        channel: "control",
        traceId: expect.stringMatching(/^t_[a-f0-9]{8}$/),
      }),
    );
  });

  it("cancels a Control queue item that is not consumed before the deadline", async () => {
    vi.useFakeTimers();
    try {
      const cancelQueued = vi.fn(() => true);
      let queuedMessageId: string | undefined;
      const enqueue = vi.fn((msg) => {
        queuedMessageId = msg.id;
        return "queued" as const;
      });
      const send = vi.fn();
      const deps = {
        config: { projectSessionPrefix: "tmux_" },
        queue: { enqueue, cancelQueued },
      } as unknown as HandlerDeps;

      await handleControlRequest(
        deps,
        { id: 103, op: "send", session: "worker-a", text: "hello" },
        send,
      );

      expect(cancelQueued).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(cancelQueued).toHaveBeenCalledWith(
        "worker-a",
        queuedMessageId,
        "control message was not consumed before deadline",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cancel a Control queue item after the queue starts it", async () => {
    vi.useFakeTimers();
    try {
      const cancelQueued = vi.fn(() => true);
      const enqueue = vi.fn((msg) => {
        msg.started?.();
        return "queued" as const;
      });
      const send = vi.fn();
      const deps = {
        config: { projectSessionPrefix: "tmux_" },
        queue: { enqueue, cancelQueued },
      } as unknown as HandlerDeps;

      await handleControlRequest(
        deps,
        { id: 104, op: "send", session: "worker-a", text: "hello" },
        send,
      );
      await vi.advanceTimersByTimeAsync(30_000);

      expect(cancelQueued).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
