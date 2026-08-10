import { describe, expect, it, vi } from "vitest";
import { delegatedTaskCancellationReason } from "../../src/core/autopilot/delegated-task.js";
import {
  executeResourceActions,
  planResourceActions,
  sanitizeResourceActionReason,
} from "../../src/core/resource-guardian/actions.js";
import type { ProcessOwnership, ResourceProcess } from "../../src/core/resource-guardian/types.js";

const process = (pid: number, overrides: Partial<ResourceProcess> = {}): ResourceProcess => ({
  pid,
  ppid: 1,
  pgid: pid,
  startedAt: "2026-08-09T00:00:00.000Z",
  cpuPct: 10,
  rssKb: 1,
  command: "node worker",
  ...overrides,
});

const owned = (
  classification: ProcessOwnership["classification"],
  pid = 10,
  overrides: Partial<ProcessOwnership> = {},
): ProcessOwnership => ({
  classification,
  strong: true,
  process: process(pid),
  workOrderId: "wo-1",
  evidence: ["test"],
  ...overrides,
});

describe("planResourceActions", () => {
  it("does not plan effects outside protect emergency with a durable background closure", () => {
    const candidate = owned("bot-active");
    for (const input of [
      { mode: "observe" as const, pressure: "emergency" as const, circuit: "open" as const },
      {
        mode: "protect" as const,
        pressure: "critical" as const,
        circuit: "background-closed" as const,
      },
      {
        mode: "protect" as const,
        pressure: "emergency" as const,
        circuit: "heavy-closed" as const,
      },
    ]) {
      expect(planResourceActions({ ...input, candidates: [candidate] })).toEqual({ kind: "none" });
    }
  });

  it("ranks bot CPU descending, low task priority first, then oldest start", () => {
    const selected = planResourceActions({
      mode: "protect",
      pressure: "emergency",
      circuit: "background-closed",
      candidates: [
        {
          ...owned("bot-active", 1),
          taskPriority: 1,
          taskKind: "active-delegated-task",
          cancellable: true,
        },
        {
          ...owned("bot-active", 2, {
            process: process(2, { cpuPct: 50, startedAt: "2026-08-09T00:01:00.000Z" }),
          }),
          taskPriority: 10,
          taskKind: "active-delegated-task",
          cancellable: true,
        },
        {
          ...owned("bot-active", 3, {
            process: process(3, { cpuPct: 50, startedAt: "2026-08-09T00:00:00.000Z" }),
          }),
          taskPriority: 10,
          taskKind: "active-delegated-task",
          cancellable: true,
        },
      ],
    });
    expect(selected).toMatchObject({ kind: "reduce-load", candidate: { process: { pid: 3 } } });
  });

  it("never treats an unspecified priority as the lowest-priority work", () => {
    const selected = planResourceActions({
      mode: "protect",
      pressure: "emergency",
      circuit: "background-closed",
      candidates: [{ ...owned("bot-terminal", 1), taskPriority: 10 }, owned("bot-terminal", 2)],
    });

    expect(selected).toMatchObject({ kind: "reduce-load", candidate: { process: { pid: 1 } } });
  });

  it("only plans cancellable active delegated work, terminal work, or stale work", () => {
    const selected = planResourceActions({
      mode: "protect",
      pressure: "emergency",
      circuit: "background-closed",
      candidates: [
        { ...owned("bot-active", 1), taskKind: "architecture", cancellable: false },
        { ...owned("bot-terminal", 2) },
      ],
    });

    expect(selected).toMatchObject({ kind: "reduce-load", candidate: { process: { pid: 2 } } });
  });
});

describe("delegated cancellation reason", () => {
  it("preserves user cancellation while marking resource-pressure cancellation distinctly", () => {
    expect(delegatedTaskCancellationReason()).toBe("cancelled by user");
    expect(delegatedTaskCancellationReason("resource-pressure")).toBe(
      "cancelled by resource pressure",
    );
  });
});

describe("resource action evidence", () => {
  it("redacts credentials, secrets, and absolute paths before an action reason is persisted", () => {
    const reason = sanitizeResourceActionReason(
      new Error(
        "token=top-secret password: hunter2 https://alice:pw@example.test/private /Users/tester/private",
      ),
    );

    expect(reason).not.toContain("top-secret");
    expect(reason).not.toContain("hunter2");
    expect(reason).not.toContain("alice:pw");
    expect(reason).not.toContain("/Users/tester/private");
  });
});

describe("executeResourceActions", () => {
  it("orders reconcile, cooperative cancellation, grace, TERM revalidation, then KILL revalidation", async () => {
    const events: string[] = [];
    const terminal = owned("bot-terminal");
    const collect = vi
      .fn()
      .mockResolvedValueOnce([terminal])
      .mockResolvedValueOnce([terminal])
      .mockResolvedValueOnce([]);
    await executeResourceActions({
      plan: {
        kind: "reduce-load",
        candidate: { ...owned("bot-active"), taskKind: "active-delegated-task", cancellable: true },
      },
      reconcile: async () => {
        events.push("reconcile");
      },
      cancel: async (runId) => {
        events.push(`cancel:${runId}`);
        return { status: "cancelled" as const };
      },
      wait: async () => {
        events.push("wait");
      },
      collect,
      signal: async (_pid, signal) => {
        events.push(signal);
      },
    });
    expect(events).toEqual([
      "reconcile",
      "cancel:wo-1",
      "wait",
      "SIGTERM",
      "wait",
      "SIGKILL",
      "wait",
    ]);
  });

  it("has no observe effects and stops after reconcile failure", async () => {
    const noEffects = vi.fn();
    await expect(
      executeResourceActions({
        plan: { kind: "none" },
        reconcile: noEffects,
        cancel: async () => ({ status: "cancelled" as const }),
        wait: noEffects,
        collect: noEffects,
        signal: noEffects,
      }),
    ).resolves.toMatchObject({ outcome: "skipped" });
    await expect(
      executeResourceActions({
        plan: { kind: "reduce-load", candidate: owned("bot-active") },
        reconcile: async () => Promise.reject(new Error("cleanup failed")),
        cancel: async () => ({ status: "cancelled" as const }),
        wait: noEffects,
        collect: noEffects,
        signal: noEffects,
      }),
    ).resolves.toMatchObject({ outcome: "failed" });
    expect(noEffects).not.toHaveBeenCalled();
  });

  it("never signals external, unknown, changed, or still-active candidates", async () => {
    const signal = vi.fn();
    for (const afterGrace of [
      { ...owned("external"), strong: false },
      { ...owned("unknown"), strong: false },
      owned("bot-active"),
      owned("bot-terminal", 10, {
        process: process(10, { startedAt: "2026-08-09T00:01:00.000Z" }),
      }),
    ]) {
      await executeResourceActions({
        plan: { kind: "reduce-load", candidate: owned("bot-terminal") },
        reconcile: async () => {},
        cancel: async () => ({ status: "cancelled" as const }),
        wait: async () => {},
        collect: async () => [afterGrace],
        signal,
      });
    }
    expect(signal).not.toHaveBeenCalled();
  });

  it("does not KILL after TERM unless the same revalidated candidate remains terminal or stale", async () => {
    const signal = vi.fn();
    await executeResourceActions({
      plan: { kind: "reduce-load", candidate: owned("bot-terminal") },
      reconcile: async () => {},
      cancel: async () => ({ status: "cancelled" as const }),
      wait: async () => {},
      collect: vi
        .fn()
        .mockResolvedValueOnce([owned("bot-terminal")])
        .mockResolvedValueOnce([owned("bot-active")]),
      signal,
    });
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(10, "SIGTERM");
  });

  it("fails closed when wait or collection fails", async () => {
    for (const failing of ["wait", "collect"] as const) {
      const signal = vi.fn();
      await expect(
        executeResourceActions({
          plan: { kind: "reduce-load", candidate: owned("bot-terminal") },
          reconcile: async () => {},
          cancel: async () => ({ status: "cancelled" as const }),
          wait: async () => {
            if (failing === "wait") throw new Error("grace unavailable");
          },
          collect: async () => {
            if (failing === "collect") throw new Error("sample unavailable");
            return [owned("bot-terminal")];
          },
          signal,
        }),
      ).resolves.toMatchObject({ outcome: "failed" });
      expect(signal).not.toHaveBeenCalled();
    }
  });

  it("returns a sanitized failure reason when collection exposes credentials", async () => {
    const result = await executeResourceActions({
      plan: { kind: "reduce-load", candidate: owned("bot-terminal") },
      reconcile: async () => {},
      cancel: async () => ({ status: "cancelled" as const }),
      wait: async () => {},
      collect: async () => {
        throw new Error(
          "token=top-secret https://alice:pw@example.test/private /Users/tester/private",
        );
      },
      signal: async () => {},
    });

    expect(result).toMatchObject({ outcome: "failed" });
    expect(result.reason).not.toContain("top-secret");
    expect(result.reason).not.toContain("alice:pw");
    expect(result.reason).not.toContain("/Users/tester/private");
  });

  it("does not signal the same process instance when durable work-order evidence changed", async () => {
    const signal = vi.fn();
    await executeResourceActions({
      plan: { kind: "reduce-load", candidate: owned("bot-terminal") },
      reconcile: async () => {},
      cancel: async () => ({ status: "cancelled" as const }),
      wait: async () => {},
      collect: async () => [owned("bot-terminal", 10, { workOrderId: "wo-2" })],
      signal,
    });
    expect(signal).not.toHaveBeenCalled();
  });

  it("does not direct signal an active task when cooperative cancellation is not confirmed", async () => {
    const signal = vi.fn();
    await expect(
      executeResourceActions({
        plan: {
          kind: "reduce-load",
          candidate: {
            ...owned("bot-active"),
            taskKind: "active-delegated-task",
            cancellable: true,
          },
        },
        reconcile: async () => {},
        cancel: async () => ({ status: "not-found" as const }),
        wait: async () => {},
        collect: async () => [owned("bot-terminal")],
        signal,
      }),
    ).resolves.toMatchObject({ outcome: "failed" });
    expect(signal).not.toHaveBeenCalled();
  });

  it("confirms absence after KILL before reporting a completed lifecycle", async () => {
    const terminal = owned("bot-terminal");
    const result = await executeResourceActions({
      plan: { kind: "reduce-load", candidate: terminal },
      reconcile: async () => {},
      cancel: async () => ({ status: "cancelled" as const }),
      wait: async () => {},
      collect: vi
        .fn()
        .mockResolvedValueOnce([terminal])
        .mockResolvedValueOnce([terminal])
        .mockResolvedValueOnce([]),
      signal: async () => {},
    });
    expect(result).toEqual({ outcome: "completed", reason: "KILL confirmed process absent" });
  });
});
