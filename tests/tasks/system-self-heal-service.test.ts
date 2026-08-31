import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startActiveDelegatedTask } from "../../src/core/autopilot/delegated-task.js";
import type { HandlerDeps } from "../../src/core/deps.js";
import { RepairCoordinator } from "../../src/core/tasks/repair-coordinator.js";
import {
  runSystemSelfHealTick,
  startSystemSelfHeal,
} from "../../src/core/tasks/system-self-heal-service.js";
import { DailyTaskLedger } from "../../src/core/tasks/task-ledger.js";

vi.mock("../../src/core/autopilot/delegated-task.js", () => ({
  startActiveDelegatedTask: vi.fn(async () => ({
    status: "queued",
    runId: "self-heal-run",
    projectId: "tmux-claude-bot",
    supervisorSession: "tmux_proj_loop-supervisor-1",
    reportDir: null,
  })),
}));

type StartSystemSelfHealOptions = NonNullable<Parameters<typeof startSystemSelfHeal>[1]>;
type RunTickInput = Parameters<NonNullable<StartSystemSelfHealOptions["runTick"]>>[0];

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("system self-heal service", () => {
  it("runs the deterministic health repair tick without waiting for the daily audit schedule", async () => {
    const runAudit = vi.fn(async () => ({ fired: false as const, reason: "not-due" as const }));
    const result = await runSystemSelfHealTick({
      now: 1_000,
      config: {
        enabled: true,
        tickMs: 3_600_000,
        agentSweepEnabled: true,
      },
      runAudit,
      runAgentSweep: vi.fn(async () => "queued" as const),
    });

    expect(result).toEqual({
      fired: true,
      audit: { fired: false, reason: "not-due" },
      agentSweep: "queued",
    });
    expect(runAudit).toHaveBeenCalledWith({ now: 1_000, force: false });
  });

  it("starts an immediate tick and then repeats hourly", () => {
    const timers: Array<{ tick: () => void; delayMs: number }> = [];
    const runTick = vi.fn(async () => ({
      fired: true as const,
      audit: { fired: false as const, reason: "not-due" as const },
      agentSweep: "queued" as const,
    }));
    const stop = startSystemSelfHeal(
      {
        config: {
          systemSelfHeal: {
            enabled: true,
            tickMs: 3_600_000,
            agentSweepEnabled: true,
          },
        },
      } as never,
      {
        now: () => 1_000,
        runTick,
        setInterval: (tick, delayMs) => {
          timers.push({ tick, delayMs });
          return 7 as never;
        },
        clearInterval: vi.fn(),
      },
    );

    expect(runTick).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(3_600_000);
    timers[0]?.tick();
    expect(runTick).toHaveBeenCalledTimes(2);

    stop();
  });

  it("keeps hourly reconciliation independent from the daily audit schedule switch", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-system-self-heal-"));
    let audit: Awaited<ReturnType<Parameters<typeof runSystemSelfHealTick>[0]["runAudit"]>>;
    const deps = {
      bridge: {
        killSession: vi.fn(),
      },
      notifications: {
        notify: vi.fn(),
      },
      config: {
        projectSessionPrefix: "tmux_proj_",
        systemSelfHeal: {
          enabled: true,
          tickMs: 3_600_000,
          agentSweepEnabled: true,
        },
        taskAudit: {
          enabled: false,
          tickMs: 0,
          schedule: "0 0 1 1 *",
          repoPath: "/repo",
          repairBranch: "dev",
          autoRepair: false,
          repairWorktreeIsolation: "isolated",
          channel: "lark",
        },
        loopEngineering: {
          configFile: undefined,
          supervisor: {
            worktreeIsolation: "isolated",
          },
        },
      },
    } as unknown as HandlerDeps;
    const runTick = vi.fn(async (input: RunTickInput) => {
      audit = await input.runAudit({ now: Date.parse("2026-08-17T10:00:00Z"), force: false });
      return {
        fired: true as const,
        audit,
        agentSweep: "disabled" as const,
      };
    });

    startSystemSelfHeal(deps, {
      now: () => 2_000,
      runTick,
      setInterval: () => 7 as never,
      clearInterval: vi.fn(),
    });

    await vi.waitFor(() => expect(audit).toEqual({ fired: false, reason: "not-due" }));
  });

  it("dispatches the agent sweep with operator-equivalent admission and autonomous notification", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-system-self-heal-"));
    const deps = {
      config: {
        projectSessionPrefix: "tmux_proj_",
        systemSelfHeal: {
          enabled: true,
          tickMs: 3_600_000,
          agentSweepEnabled: true,
        },
        taskAudit: {
          enabled: false,
          tickMs: 0,
          schedule: "0 0 1 1 *",
          repoPath: "/repo/tmux-claude-bot",
          repairBranch: "dev",
          autoRepair: false,
          repairWorktreeIsolation: "isolated",
          channel: "lark",
        },
        loopEngineering: {
          configFile: undefined,
          supervisor: {
            worktreeIsolation: "isolated",
          },
        },
      },
      bridge: { killSession: vi.fn() },
      notifications: { notify: vi.fn() },
    } as unknown as HandlerDeps;
    const runTick = vi.fn(async (input: RunTickInput) => ({
      fired: true as const,
      audit: { fired: false as const, reason: "not-due" as const },
      agentSweep: await input.runAgentSweep(),
    }));

    startSystemSelfHeal(deps, {
      now: () => 2_000,
      runTick,
      setInterval: () => 7 as never,
      clearInterval: vi.fn(),
    });

    await vi.waitFor(() =>
      expect(startActiveDelegatedTask).toHaveBeenCalledWith(
        deps,
        expect.objectContaining({
          session: "tmux_proj_-repo-tmux-claude-bot",
          resourceTrigger: "operator",
          resourceForce: false,
          notificationMode: "autonomous",
          requirement: expect.stringContaining("operator-equivalent"),
        }),
      ),
    );
    const [, request] = vi.mocked(startActiveDelegatedTask).mock.calls[0] ?? [];
    expect(request?.requirement).toContain("Do not narrow the investigation to a fixed checklist");
    expect(request?.requirement).toContain(
      "For every abnormality, also investigate why existing automation did not detect, retry, or repair it without a manual prompt",
    );
    expect(request?.requirement).toContain(
      "If the missing automation is bot-owned, fix that automation gap too",
    );
    expect(request?.requirement).toContain("commit the change on the dev branch");
    expect(request?.requirement).toContain("push it to origin/dev");
    expect(request?.requirement).toContain("run git pull --rebase after a successful push");
    expect(request?.requirement).toContain("must not leave this repository with a dirty worktree");
  });

  it("records blocked agent sweep attempts as retryable failures in the task ledger", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-system-self-heal-blocked-"));
    vi.mocked(startActiveDelegatedTask).mockResolvedValueOnce({
      status: "blocked",
      reason: "automation admission deferred: capacity-unknown-active-lease",
      showQueue: false,
    });
    const deps = {
      config: {
        projectSessionPrefix: "tmux_proj_",
        systemSelfHeal: {
          enabled: true,
          tickMs: 3_600_000,
          agentSweepEnabled: true,
        },
        taskAudit: {
          enabled: false,
          tickMs: 0,
          schedule: "0 0 1 1 *",
          repoPath: "/repo/tmux-claude-bot",
          repairBranch: "dev",
          autoRepair: false,
          repairWorktreeIsolation: "isolated",
          channel: "lark",
        },
        loopEngineering: {
          configFile: undefined,
          supervisor: {
            worktreeIsolation: "isolated",
          },
        },
      },
      bridge: { killSession: vi.fn() },
      notifications: { notify: vi.fn() },
    } as unknown as HandlerDeps;
    const runTick = vi.fn(async (input: RunTickInput) => ({
      fired: true as const,
      audit: { fired: false as const, reason: "not-due" as const },
      agentSweep: await input.runAgentSweep(),
    }));

    startSystemSelfHeal(deps, {
      now: () => 2_000,
      runTick,
      setInterval: () => 7 as never,
      clearInterval: vi.fn(),
    });

    await vi.waitFor(() =>
      expect(new DailyTaskLedger().listAll()).toContainEqual(
        expect.objectContaining({
          taskId: "system-self-heal:agent-sweep:2000",
          source: "system-self-heal",
          name: "tmux-claude-bot system self-heal agent sweep",
          status: "failed",
          repairStatus: "pending",
          failureKind: "system-gate",
          error: "automation admission deferred: capacity-unknown-active-lease",
          summary:
            "System self-heal agent sweep deferred before WorkOrder creation: automation admission deferred: capacity-unknown-active-lease",
        }),
      ),
    );
  });

  it("links a queued self-heal sweep to pending self-heal repair evidence", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-system-self-heal-linkage-"));
    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: "system-self-heal:agent-sweep:1000",
      source: "system-self-heal",
      name: "tmux-claude-bot system self-heal agent sweep",
      scheduledAt: 1_000,
      summary: "System self-heal attempted to queue the broad active-agent sweep.",
    });
    ledger.start("system-self-heal:agent-sweep:1000", 1_000);
    ledger.fail("system-self-heal:agent-sweep:1000", {
      endedAt: 1_000,
      error: "project already has active automation: bug-fix 1 (in-flight)",
      summary:
        "System self-heal agent sweep deferred before WorkOrder creation: project already has active automation: bug-fix 1 (in-flight)",
    });

    const deps = {
      config: {
        projectSessionPrefix: "tmux_proj_",
        systemSelfHeal: {
          enabled: true,
          tickMs: 3_600_000,
          agentSweepEnabled: true,
        },
        taskAudit: {
          enabled: false,
          tickMs: 0,
          schedule: "0 0 1 1 *",
          repoPath: "/repo/tmux-claude-bot",
          repairBranch: "dev",
          autoRepair: false,
          repairWorktreeIsolation: "isolated",
          channel: "lark",
        },
        loopEngineering: {
          configFile: undefined,
          supervisor: {
            worktreeIsolation: "isolated",
          },
        },
      },
      bridge: { killSession: vi.fn() },
      notifications: { notify: vi.fn() },
    } as unknown as HandlerDeps;
    const runTick = vi.fn(async (input: RunTickInput) => ({
      fired: true as const,
      audit: await input.runAudit({ now: 2_000, force: false }),
      agentSweep: await input.runAgentSweep(),
    }));

    startSystemSelfHeal(deps, {
      now: () => 2_000,
      runTick,
      setInterval: () => 7 as never,
      clearInterval: vi.fn(),
    });

    await vi.waitFor(() => {
      const record = new RepairCoordinator()
        .list()
        .find((candidate) => candidate.source === "system-self-heal");
      expect(record).toMatchObject({
        status: "running",
        linkedTaskIds: ["system-self-heal:agent-sweep:1000", "autopilot:self-heal-run"],
      });
      expect(
        new DailyTaskLedger()
          .listAll()
          .find((item) => item.taskId === "system-self-heal:agent-sweep:1000"),
      ).toMatchObject({
        repairStatus: "running",
        summary: expect.stringContaining("System self-heal delegated this item."),
      });
    });
  });
});
