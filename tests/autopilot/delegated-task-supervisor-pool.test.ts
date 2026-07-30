import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerDeps } from "../../src/core/deps.js";
import {
  listUnfinishedLoopSupervisorWorkOrders,
  writeLoopSupervisorWorkOrderState,
} from "../../src/core/loop/supervisor-state.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";
import { setPathForSession } from "../../src/core/projects/sessionPathMap.js";
import type { AppConfig } from "../../src/shared/types.js";

const startLoopSupervisor = vi.fn();

vi.mock("../../src/core/loop/supervisor-session.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/core/loop/supervisor-session.js")>();
  return {
    ...original,
    startLoopSupervisor: (...args: Parameters<typeof original.startLoopSupervisor>) =>
      startLoopSupervisor(...args),
  };
});

const originalStateDir = process.env.TCB_STATE_DIR;

function config(poolSize: number): AppConfig {
  return {
    projectSessionPrefix: "tmux_proj_",
    startCommands: [],
    claudeStartCommand: "claude",
    loopEngineering: {
      configFile: "",
      supervisor: {
        enabled: true,
        agent: "codex",
        dir: join(process.env.TCB_STATE_DIR ?? tmpdir(), "supervisors"),
        poolSize,
        resetBeforeWorkOrder: "compact",
      },
    },
  } as unknown as AppConfig;
}

function deps(poolSize: number): HandlerDeps {
  return {
    config: config(poolSize),
    configResolver: {
      detectAgentKind: vi.fn(async () => "codex"),
    },
    queue: {
      enqueue: vi.fn(() => false),
    },
  } as unknown as HandlerDeps;
}

function workOrder(input: {
  id: string;
  projectPath: string;
  supervisorSession?: string;
  finalSummaryPath?: string;
}): LoopWorkOrder {
  return {
    id: input.id,
    projectId: input.id,
    projectName: input.id,
    projectPath: input.projectPath,
    session: `tmux_proj_${input.id}`,
    agent: "codex",
    scheduledAt: 1,
    requiredFinalMarker: `[LOOP_SUPERVISOR_DONE:${input.id}]`,
    finalSummaryPath: input.finalSummaryPath,
  } as unknown as LoopWorkOrder;
}

describe("active delegated task supervisor pool", () => {
  beforeEach(() => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-delegate-pool-"));
    startLoopSupervisor.mockReset();
  });

  afterEach(() => {
    const stateDir = process.env.TCB_STATE_DIR;
    if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true });
    if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = originalStateDir;
  });

  it("tries the next supervisor when the first candidate cannot be ensured", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-project-"));
    setPathForSession("tmux_proj_project", projectDir);
    startLoopSupervisor.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const result = await startActiveDelegatedTask(deps(2), {
      session: "tmux_proj_project",
      requirement: "fix the confirmed issue",
    });

    expect(result).toMatchObject({
      status: "queued",
      supervisorSession: "tmux_proj_loop-supervisor-2",
    });
    expect(startLoopSupervisor.mock.calls.map((call) => call[2])).toEqual([
      "tmux_proj_loop-supervisor-1",
      "tmux_proj_loop-supervisor-2",
    ]);
  });

  it("keeps recoverable failed supervisor work orders reserved during allocation", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-project-"));
    const staleProjectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-stale-"));
    setPathForSession("tmux_proj_project", projectDir);
    const summaryDir = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-runs",
      "recoverable",
      "recoverable",
    );
    const finalSummaryPath = join(summaryDir, "supervisor-final-summary.json");
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder({
        id: "recoverable",
        projectPath: staleProjectDir,
        finalSummaryPath,
      }),
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "failed",
      resultStatus: "invalid-output",
      now: 2,
    });
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(
      finalSummaryPath,
      `${JSON.stringify({
        status: "completed",
        projectId: "recoverable",
        actionsTaken: ["late summary arrived"],
        delegatedTasks: [],
        finalVerification: "passed",
        commits: [],
        followUps: [],
      })}\n`,
    );
    startLoopSupervisor.mockResolvedValueOnce(true);

    const result = await startActiveDelegatedTask(deps(2), {
      session: "tmux_proj_project",
      requirement: "fix the confirmed issue",
    });

    expect(result).toMatchObject({
      status: "queued",
      supervisorSession: "tmux_proj_loop-supervisor-2",
    });
    expect(startLoopSupervisor.mock.calls.map((call) => call[2])).toEqual([
      "tmux_proj_loop-supervisor-2",
    ]);
  });

  it("does not reserve failed supervisor work orders that have no final summary to recover", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-project-"));
    const staleProjectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-stale-"));
    setPathForSession("tmux_proj_project", projectDir);
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder({ id: "unrecoverable", projectPath: staleProjectDir }),
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "failed",
      resultStatus: "dispatch-failed",
      now: 2,
    });
    startLoopSupervisor.mockResolvedValueOnce(true);

    const result = await startActiveDelegatedTask(deps(2), {
      session: "tmux_proj_project",
      requirement: "fix the confirmed issue",
    });

    expect(result).toMatchObject({
      status: "queued",
      supervisorSession: "tmux_proj_loop-supervisor-1",
    });
    expect(startLoopSupervisor.mock.calls.map((call) => call[2])).toEqual([
      "tmux_proj_loop-supervisor-1",
    ]);
  });

  it("does not reserve failed supervisor work orders with invalid final summaries", async () => {
    const { startActiveDelegatedTask } = await import("../../src/core/autopilot/delegated-task.js");
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-project-"));
    const staleProjectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-stale-"));
    setPathForSession("tmux_proj_project", projectDir);
    const summaryDir = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-runs",
      "invalid-recoverable",
      "invalid-recoverable",
    );
    const finalSummaryPath = join(summaryDir, "supervisor-final-summary.json");
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder({
        id: "invalid-recoverable",
        projectPath: staleProjectDir,
        finalSummaryPath,
      }),
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "failed",
      resultStatus: "invalid-output",
      now: 2,
    });
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(finalSummaryPath, '{"status":"completed"}\n');
    startLoopSupervisor.mockResolvedValueOnce(true);

    const result = await startActiveDelegatedTask(deps(2), {
      session: "tmux_proj_project",
      requirement: "fix the confirmed issue",
    });

    expect(result).toMatchObject({
      status: "queued",
      supervisorSession: "tmux_proj_loop-supervisor-1",
    });
  });

  it("does not keep stale unfinished work orders reserved without a final summary", () => {
    const staleProjectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-stale-"));
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder({ id: "stale-dispatching", projectPath: staleProjectDir }),
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "dispatching",
      now: Date.now() - 13 * 60 * 60 * 1000,
    });

    expect(listUnfinishedLoopSupervisorWorkOrders()).toEqual([]);
  });

  it("does not keep unfinished work orders reserved after an invalid final summary grace period", () => {
    const staleProjectDir = mkdtempSync(join(tmpdir(), "tcb-delegate-stale-invalid-"));
    const summaryDir = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-runs",
      "stale-invalid-summary",
      "stale-invalid-summary",
    );
    const finalSummaryPath = join(summaryDir, "supervisor-final-summary.json");
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder({
        id: "stale-invalid-summary",
        projectPath: staleProjectDir,
        finalSummaryPath,
      }),
      supervisorSession: "tmux_proj_loop-supervisor-1",
      status: "dispatching",
      now: Date.now() - 10 * 60 * 1000,
    });
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(finalSummaryPath, '{"status":"completed"}\n');

    expect(listUnfinishedLoopSupervisorWorkOrders()).toEqual([]);
  });
});
