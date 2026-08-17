import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HandlerDeps } from "../../src/core/deps.js";
import {
  runSystemSelfHealTick,
  startSystemSelfHeal,
} from "../../src/core/tasks/system-self-heal-service.js";

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
      },
      runAudit,
    });

    expect(result).toEqual({
      fired: true,
      audit: { fired: false, reason: "not-due" },
    });
    expect(runAudit).toHaveBeenCalledWith({ now: 1_000, force: false });
  });

  it("starts an immediate tick and then repeats hourly", () => {
    const timers: Array<{ tick: () => void; delayMs: number }> = [];
    const runTick = vi.fn(async () => ({
      fired: true as const,
      audit: { fired: false as const, reason: "not-due" as const },
    }));
    const stop = startSystemSelfHeal(
      {
        config: {
          systemSelfHeal: {
            enabled: true,
            tickMs: 3_600_000,
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
});
