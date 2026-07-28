import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listLoopReports } from "../../src/core/loop/report.js";
import { reconcileLoopSupervisorWorkOrders } from "../../src/core/loop/service.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";
import { DailyTaskLedger, singaporeDayWindow } from "../../src/core/tasks/task-ledger.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

function writeConfig(projectPath: string, projectExtra = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-config-"));
  const file = join(dir, "loop.yml");
  writeFileSync(
    file,
    `
projects:
  - id: hub
    name: Hub
    path: ${projectPath}
    agent: codex
    schedule: "*/5 * * * *"
    runner:
      kind: agent-supervised
      timeoutMs: 1000
    goal: Improve architecture in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
    execution:
      agent: true
${projectExtra}
    allowedActions: [tests]
`,
  );
  return file;
}

function workOrder(stateDir: string, projectPath: string): LoopWorkOrder {
  const runId = "1784196600000-hub";
  return {
    id: runId,
    scheduledAt: 1_784_196_600_000,
    projectId: "hub",
    projectName: "Hub",
    projectPath,
    agent: "codex",
    goal: "Improve architecture in small verified slices.",
    maxRounds: 1,
    targetScore: 90,
    runner: { kind: "agent-supervised", timeoutMs: 1000, requireConfirmation: false },
    allowedActions: ["tests"],
    blockedActions: [],
    skills: { approved: [] },
    preflight: { commands: [], repair: { agent: false } },
    assessment: { command: "npm run assess" },
    execution: { agent: true },
    recovery: { agent: false, dirtyWorktree: false, maxAttempts: 1 },
    commitPolicy: { enabled: false, perRound: true },
    pullRequestPolicy: { enabled: false, base: "main", switchBack: "main", autoMerge: false },
    requiredFinalMarker: `[LOOP_SUPERVISOR_DONE:${runId}]`,
    finalSummaryPath: join(stateDir, "loop-runs", "hub", runId, "supervisor-final-summary.json"),
  };
}

function writeUnfinishedRun(stateDir: string, order: LoopWorkOrder): string {
  const runDir = join(stateDir, "loop-runs", "hub", order.id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "work-order.json"), `${JSON.stringify(order, null, 2)}\n`);
  writeFileSync(
    join(runDir, "work-order-state.json"),
    `${JSON.stringify(
      {
        status: "in-flight",
        projectId: "hub",
        runId: order.id,
        supervisorSession: "tmux_proj_loop-supervisor",
        scheduledAt: order.scheduledAt,
        updatedAt: 1_000,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    order.finalSummaryPath ?? "",
    `${JSON.stringify({
      status: "completed",
      projectId: "hub",
      actionsTaken: ["finished before restart"],
      delegatedTasks: ["Round 1: deepened a module"],
      finalVerification: "passed",
      commits: order.commitPolicy.enabled ? ["abc123 refactor: deepen module"] : [],
      followUps: ["Keep an eye on the next scheduled run"],
    })}\n`,
  );
  return runDir;
}

describe("loop supervisor work order reconciliation", () => {
  it("completes an in-flight work order from the final summary file after a bot restart", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-project-"));
    const configFile = writeConfig(projectDir);
    const order = workOrder(stateDir, projectDir);
    const runDir = writeUnfinishedRun(stateDir, order);

    const result = reconcileLoopSupervisorWorkOrders({
      configFile,
      now: 2_000,
      runCommand: () => {
        throw new Error("PR commands should not run without supervisor commits");
      },
    });

    expect(result).toEqual({ checked: 1, recovered: 1, failed: 0 });
    expect(listLoopReports()).toEqual([
      expect.objectContaining({
        runId: order.id,
        projectId: "hub",
        status: "passed",
        startedAt: 1_000,
        endedAt: 2_000,
      }),
    ]);
    expect(readFileSync(join(runDir, "work-order-state.json"), "utf8")).toContain(
      '"status": "completed"',
    );
  });

  it("runs the supervised PR gate when reconciling a completed work order", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-project-"));
    const configFile = writeConfig(
      projectDir,
      [
        "    commit:",
        "      enabled: true",
        "      branch: loop/hub/architecture",
        "    pullRequest:",
        "      enabled: true",
        "      base: dev",
        "      switchBack: dev",
      ].join("\n"),
    );
    const order = {
      ...workOrder(stateDir, projectDir),
      commitPolicy: {
        enabled: true,
        perRound: true,
        branch: "loop/hub/architecture/1784196600000-hub",
      },
      pullRequestPolicy: {
        enabled: true,
        base: "dev",
        switchBack: "dev",
        autoMerge: false,
      },
    } satisfies LoopWorkOrder;
    const runDir = writeUnfinishedRun(stateDir, order);
    const prCommands: string[] = [];

    const result = reconcileLoopSupervisorWorkOrders({
      configFile,
      now: 2_000,
      runCommand: (invocation) => {
        prCommands.push(invocation.command);
        return {
          status: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            mergeable: "MERGEABLE",
            statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
            body: "## Summary\n- Deepened one module.",
            files: [{ path: "README.md" }],
            commits: [{ oid: "abc123" }],
          }),
          stderr: "",
        };
      },
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "branch --show-current") {
          return { status: 0, stdout: "dev\n", stderr: "" };
        }
        if (invocation.args.join(" ") === "show --format= --name-only abc123") {
          return { status: 0, stdout: "README.md\n", stderr: "" };
        }
        throw new Error(`unexpected git args: ${invocation.args.join(" ")}`);
      },
    });

    expect(result).toEqual({ checked: 1, recovered: 1, failed: 0 });
    expect(prCommands).toEqual([
      "gh pr view 'loop/hub/architecture/1784196600000-hub' --json url,state,mergeable,statusCheckRollup,body,files,commits,mergeCommit",
    ]);
    expect(readFileSync(join(runDir, "work-order-state.json"), "utf8")).toContain(
      '"status": "completed"',
    );
  });

  it("reconciles bug-fix work orders with the bug-fix scheduler key", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-reconcile-project-"));
    const configFile = writeConfig(
      projectDir,
      [
        "    bugFix:",
        "      enabled: true",
        '      schedule: "*/5 * * * *"',
        "      maxRounds: 2",
        "      maxBugsPerRound: 1",
      ].join("\n"),
    );
    const order = {
      ...workOrder(stateDir, projectDir),
      id: "1784196600000-hub-bug-fix",
      task: {
        kind: "bug-fix",
        maxRounds: 2,
        maxBugsPerRound: 1,
        requireRegressionTest: true,
      },
      requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:1784196600000-hub-bug-fix]",
      finalSummaryPath: join(
        stateDir,
        "loop-runs",
        "hub",
        "1784196600000-hub-bug-fix",
        "supervisor-final-summary.json",
      ),
    } satisfies LoopWorkOrder;
    writeUnfinishedRun(stateDir, order);

    const result = reconcileLoopSupervisorWorkOrders({
      configFile,
      now: 2_000,
      runCommand: () => {
        throw new Error("PR commands should not run without supervisor commits");
      },
    });

    expect(result).toEqual({ checked: 1, recovered: 1, failed: 0 });
    expect(
      new DailyTaskLedger()
        .listForWindow(singaporeDayWindow("2026-07-16"))
        .map((record) => [record.taskId, record.status, record.source]),
    ).toEqual([
      [`loop:hub:bug-fix:${Date.parse("2026-07-16T10:10:00Z")}`, "success", "loop-engineering"],
    ]);
  });
});
