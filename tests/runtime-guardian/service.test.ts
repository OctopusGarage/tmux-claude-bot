import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeLoopSupervisorWorkerLeaseState } from "../../src/core/loop/supervisor-pool.js";
import { writeLoopSupervisorWorkOrderState } from "../../src/core/loop/supervisor-state.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";
import {
  buildRuntimeGuardianRepairPrompt,
  checkRuntimeGuardianRepairReadiness,
  discoverRuntimeGuardianFindings,
  type RuntimeGuardianFinding,
  RuntimeGuardianStore,
  runRuntimeGuardianTick,
} from "../../src/core/runtime-guardian/service.js";
import { loadConfig } from "../../src/shared/config.js";
import type { AppConfig } from "../../src/shared/types.js";

const originalStateDir = process.env.TCB_STATE_DIR;

function runtimeConfig(
  overrides: Partial<AppConfig["runtimeGuardian"]> = {},
): AppConfig["runtimeGuardian"] {
  return {
    enabled: true,
    mode: "fast-heal",
    worktreeIsolation: "auto",
    tickMs: 120000,
    lookbackMs: 86_400_000,
    cooldownMs: 1_800_000,
    repoPath: "",
    repairBranch: "dev",
    maxFindingsPerTick: 3,
    ...overrides,
  };
}

function finding(overrides: Partial<RuntimeGuardianFinding> = {}): RuntimeGuardianFinding {
  return {
    kind: "missing-system-gate",
    severity: "high",
    runId: "run-1",
    projectId: "tmux-claude-bot",
    projectPath: "/repo/tmux-claude-bot",
    evidence: ["completed work-order has no system-gate.json"],
    ...overrides,
  };
}

function workOrder(id: string, projectPath: string, finalSummaryPath?: string): LoopWorkOrder {
  return {
    id,
    projectId: "tmux-claude-bot",
    projectName: "tmux-claude-bot",
    projectPath,
    scheduledAt: 1,
    requiredFinalMarker: `[LOOP_SUPERVISOR_DONE:${id}]`,
    finalSummaryPath,
  } as unknown as LoopWorkOrder;
}

describe("runtime guardian", () => {
  beforeEach(() => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-runtime-guardian-"));
  });

  afterEach(() => {
    const stateDir = process.env.TCB_STATE_DIR;
    if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true });
    if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = originalStateDir;
  });

  it("defaults runtime-guardian mode to fast-heal while remaining opt-in", () => {
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: "t" });

    expect(config.runtimeGuardian).toMatchObject({
      enabled: false,
      mode: "fast-heal",
      worktreeIsolation: "auto",
      tickMs: 120000,
      lookbackMs: 86_400_000,
      cooldownMs: 1_800_000,
      repairBranch: "dev",
      maxFindingsPerTick: 3,
    });
  });

  it("records findings without dispatching in observe mode", async () => {
    const dispatchRepair = vi.fn();

    const result = await runRuntimeGuardianTick({
      now: 10_000,
      config: runtimeConfig({ mode: "observe" }),
      discover: () => [finding()],
      dispatchRepair,
    });

    expect(result).toMatchObject({
      fired: true,
      mode: "observe",
      repairDispatch: "observe-only",
    });
    expect(dispatchRepair).not.toHaveBeenCalled();
  });

  it("delegates confirmed runtime findings in fast-heal mode with a bounded prompt", async () => {
    const dispatchRepair = vi.fn(async () => ({ status: "queued" as const, detail: "runId=abc" }));

    const result = await runRuntimeGuardianTick({
      now: 10_000,
      config: runtimeConfig({ repoPath: "/repo/tmux-claude-bot" }),
      discover: () => [finding()],
      dispatchRepair,
      checkRepairReadiness: () => ({ ok: true }),
    });

    expect(result).toMatchObject({
      fired: true,
      mode: "fast-heal",
      repairDispatch: "queued",
      detail: "runId=abc",
    });
    expect(dispatchRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "/repo/tmux-claude-bot",
        repairBranch: "dev",
        mode: "fast-heal",
      }),
    );
  });

  it("does not dispatch the same finding repeatedly during cooldown", async () => {
    const store = new RuntimeGuardianStore();
    const dispatchRepair = vi.fn(async () => ({ status: "queued" as const, detail: "runId=abc" }));

    await runRuntimeGuardianTick({
      now: 10_000,
      config: runtimeConfig(),
      store,
      discover: () => [finding()],
      dispatchRepair,
      checkRepairReadiness: () => ({ ok: true }),
    });
    const second = await runRuntimeGuardianTick({
      now: 11_000,
      config: runtimeConfig(),
      store,
      discover: () => [finding()],
      dispatchRepair,
      checkRepairReadiness: () => ({ ok: true }),
    });

    expect(second).toEqual({ fired: false, reason: "cooldown" });
    expect(dispatchRepair).toHaveBeenCalledTimes(1);
  });

  it("applies a repo-level repair cooldown after dispatching a fast-heal", async () => {
    const store = new RuntimeGuardianStore();
    const dispatchRepair = vi.fn(async () => ({ status: "queued" as const, detail: "runId=abc" }));
    await runRuntimeGuardianTick({
      now: 10_000,
      config: runtimeConfig({ repoPath: "/repo/tmux-claude-bot", maxFindingsPerTick: 1 }),
      store,
      discover: () => [finding()],
      dispatchRepair,
      checkRepairReadiness: () => ({ ok: true }),
    });

    const result = await runRuntimeGuardianTick({
      now: 11_000,
      config: runtimeConfig({ repoPath: "/repo/tmux-claude-bot", maxFindingsPerTick: 1 }),
      store,
      discover: () => [
        finding(),
        finding({ runId: "run-2", evidence: ["second unhandled finding"] }),
      ],
      dispatchRepair,
      checkRepairReadiness: () => ({ ok: true }),
    });

    expect(result).toEqual({ fired: false, reason: "cooldown" });
    expect(dispatchRepair).toHaveBeenCalledTimes(1);
  });

  it("blocks fast-heal dispatch when the bot repository is not ready for self-repair", async () => {
    const dispatchRepair = vi.fn();

    const result = await runRuntimeGuardianTick({
      now: 10_000,
      config: runtimeConfig({ repoPath: "/repo/tmux-claude-bot" }),
      discover: () => [finding()],
      dispatchRepair,
      checkRepairReadiness: () => ({
        ok: false,
        reason: "runtime guardian repo has uncommitted changes",
      }),
    });

    expect(result).toMatchObject({
      fired: true,
      repairDispatch: "blocked",
      detail: "runtime guardian repo has uncommitted changes",
    });
    expect(dispatchRepair).not.toHaveBeenCalled();
  });

  it("blocks source-worktree repair when runtime guardian is not on the repair branch", () => {
    const repo = mkdtempSync(join(tmpdir(), "tcb-runtime-guardian-branch-"));
    execFileSync("git", ["init", "-b", "feature"], { cwd: repo, stdio: "ignore" });

    const result = checkRuntimeGuardianRepairReadiness(repo, {
      repairBranch: "dev",
      worktreeIsolation: "source",
    });

    expect(result).toEqual({
      ok: false,
      reason: "runtime guardian source repair requires branch dev; current branch is feature",
    });
  });

  it("discovers completed supervisor work orders that are missing system gate evidence", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-runtime-guardian-project-"));
    const runDir = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-runs",
      "tmux-claude-bot",
      "run-missing-gate",
    );
    mkdirSync(runDir, { recursive: true });
    const summaryPath = join(runDir, "supervisor-final-summary.json");
    writeFileSync(summaryPath, "{}\n");
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder("run-missing-gate", projectDir, summaryPath),
      supervisorSession: "tmux_proj_loop-supervisor",
      status: "completed",
      now: 2,
      resultStatus: "completed",
    });

    const findings = discoverRuntimeGuardianFindings({ now: 2, lookbackMs: 86_400_000 });

    expect(existsSync(join(runDir, "system-gate.json"))).toBe(false);
    expect(findings).toEqual([
      expect.objectContaining({
        kind: "missing-system-gate",
        severity: "high",
        runId: "run-missing-gate",
      }),
    ]);
  });

  it("ignores historical completed runs outside the runtime lookback", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-runtime-guardian-project-"));
    const runDir = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-runs",
      "tmux-claude-bot",
      "run-old-missing-gate",
    );
    mkdirSync(runDir, { recursive: true });
    const summaryPath = join(runDir, "supervisor-final-summary.json");
    writeFileSync(summaryPath, "{}\n");
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder("run-old-missing-gate", projectDir, summaryPath),
      supervisorSession: "tmux_proj_loop-supervisor",
      status: "completed",
      now: 1,
      resultStatus: "completed",
    });

    expect(discoverRuntimeGuardianFindings({ now: 10_000, lookbackMs: 1000 })).toEqual([]);
  });

  it("discovers active worker leases retained for terminal work orders", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-runtime-guardian-project-"));
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder("run-terminal-lease", projectDir),
      supervisorSession: "tmux_proj_loop-supervisor",
      status: "failed",
      now: 2,
      resultStatus: "dispatch-failed",
    });
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: "tmux_proj_loop-supervisor",
          workOrderId: "run-terminal-lease",
          projectId: "tmux-claude-bot",
          projectPath: projectDir,
          status: "active",
          leasedAt: 1,
          updatedAt: 2,
        },
      ],
    });

    expect(discoverRuntimeGuardianFindings({ now: 2, lookbackMs: 86_400_000 })).toEqual([
      expect.objectContaining({
        kind: "terminal-work-order-active-lease",
        severity: "high",
        runId: "run-terminal-lease",
      }),
    ]);
  });

  it("discovers terminal supervisor dispatch failures caused by transient agent capacity", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-runtime-guardian-project-"));
    const runDir = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-runs",
      "tmux-claude-bot",
      "run-agent-capacity",
    );
    mkdirSync(runDir, { recursive: true });
    writeLoopSupervisorWorkOrderState({
      workOrder: workOrder("run-agent-capacity", projectDir),
      supervisorSession: "tmux_proj_loop-supervisor",
      status: "failed",
      now: 2,
      resultStatus: "dispatch-failed",
      revisionReasons: ["Selected model is at capacity. Please try a different model."],
    });
    writeFileSync(
      join(runDir, "supervisor-summary.json"),
      `${JSON.stringify({
        result: {
          status: "dispatch-failed",
          reason: "Selected model is at capacity. Please try a different model.",
          output: "Selected model is at capacity. Please try a different model.",
        },
      })}\n`,
    );

    expect(discoverRuntimeGuardianFindings({ now: 2, lookbackMs: 86_400_000 })).toEqual([
      expect.objectContaining({
        kind: "terminal-agent-transient-failure",
        severity: "medium",
        runId: "run-agent-capacity",
        evidence: expect.arrayContaining([
          expect.stringContaining("model-capacity"),
          expect.stringContaining("Selected model is at capacity"),
        ]),
      }),
    ]);
  });

  it("discovers read-only smoke tasks blocked by mixed dependency and non-dependency preflight", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-runtime-guardian-project-"));
    const runDir = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-runs",
      "geo-frontend",
      "run-read-only-smoke",
    );
    mkdirSync(runDir, { recursive: true });
    const summaryPath = join(runDir, "supervisor-final-summary.json");
    const order = {
      ...workOrder("run-read-only-smoke", projectDir, summaryPath),
      projectId: "geo-frontend",
      projectName: "geo-frontend",
      task: {
        kind: "active-delegated-task",
        sourceSession: "tmux_proj_geo-frontend",
        requirement:
          "Read-only smoke validation of the active delegation contract. Do not modify files.",
        requireReview: true,
        requireTests: true,
        requireCoverageReview: true,
        allowAiEval: true,
      },
      preflight: {
        commands: [
          "test -d node_modules",
          "test -x node_modules/.bin/vitest",
          "test -f .env.guard",
        ],
        repair: { agent: true },
      },
    } satisfies LoopWorkOrder;
    writeLoopSupervisorWorkOrderState({
      workOrder: order,
      supervisorSession: "tmux_proj_loop-supervisor",
      status: "failed",
      now: 2,
      resultStatus: "blocked",
    });
    writeFileSync(
      summaryPath,
      `${JSON.stringify({
        status: "blocked",
        projectId: "geo-frontend",
        actionsTaken: ["inspected isolated worktree"],
        delegatedTasks: [],
        finalVerification: "failed",
        reviewGate: {
          preMutationReview: [],
          postMutationReview: [],
          aiReview: "passed",
          deterministicGates: [
            {
              name: "local dependency preflight",
              result: "failed",
              evidence:
                "node_modules was absent and vite/vitest/eslint/prettier were missing while .env.guard was also checked",
            },
          ],
          decision: "block",
          notes: [],
        },
        commits: [],
        followUps: [],
      })}\n`,
    );

    expect(discoverRuntimeGuardianFindings({ now: 2, lookbackMs: 86_400_000 })).toEqual([
      expect.objectContaining({
        kind: "read-only-smoke-preflight-blocked",
        severity: "medium",
        runId: "run-read-only-smoke",
        projectId: "geo-frontend",
        evidence: expect.arrayContaining([
          expect.stringContaining("verification-profile/worktree-policy"),
        ]),
      }),
    ]);
  });

  it("ignores historical read-only smoke tasks whose dependency-only preflight is already neutralized by current policy", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-runtime-guardian-project-"));
    const runDir = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-runs",
      "geo-backend",
      "run-read-only-smoke-dependency-only",
    );
    mkdirSync(runDir, { recursive: true });
    const summaryPath = join(runDir, "supervisor-final-summary.json");
    const order = {
      ...workOrder("run-read-only-smoke-dependency-only", projectDir, summaryPath),
      projectId: "geo-backend",
      projectName: "geo-backend",
      task: {
        kind: "active-delegated-task",
        sourceSession: "tmux_proj_geo-backend",
        requirement:
          "Read-only smoke validation of the active delegation contract. Do not modify files, do not commit, do not open a PR.",
        requireReview: true,
        requireTests: true,
        requireCoverageReview: true,
        allowAiEval: true,
      },
      preflight: {
        commands: [
          "test -x .venv/bin/ruff",
          "test -x .venv/bin/pyright",
          "test -x .venv/bin/pytest",
        ],
        repair: { agent: true },
      },
    } satisfies LoopWorkOrder;
    writeLoopSupervisorWorkOrderState({
      workOrder: order,
      supervisorSession: "tmux_proj_loop-supervisor",
      status: "failed",
      now: 2,
      resultStatus: "blocked",
    });
    writeFileSync(
      summaryPath,
      `${JSON.stringify({
        status: "blocked",
        projectId: "geo-backend",
        actionsTaken: ["checked preflight"],
        delegatedTasks: [],
        finalVerification: "failed",
        reviewGate: {
          preMutationReview: [],
          postMutationReview: [],
          aiReview: "passed",
          deterministicGates: [
            {
              name: "preflight ruff executable",
              result: "failed",
              evidence: "exit code 1",
            },
          ],
          decision: "block",
          notes: [],
        },
        commits: [],
        followUps: [],
      })}\n`,
    );

    expect(discoverRuntimeGuardianFindings({ now: 2, lookbackMs: 86_400_000 })).toEqual([]);
  });

  it("ignores terminal invalid-output states when a valid final summary can be recovered", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-runtime-guardian-project-"));
    const runDir = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-runs",
      "tmux-claude-bot",
      "run-invalid-output-recoverable",
    );
    mkdirSync(runDir, { recursive: true });
    const summaryPath = join(runDir, "supervisor-final-summary.json");
    const order = workOrder("run-invalid-output-recoverable", projectDir, summaryPath);
    writeLoopSupervisorWorkOrderState({
      workOrder: order,
      supervisorSession: "tmux_proj_loop-supervisor",
      status: "failed",
      now: 2,
      resultStatus: "invalid-output",
    });
    writeFileSync(
      summaryPath,
      `${JSON.stringify({
        status: "completed",
        projectId: "tmux-claude-bot",
        actionsTaken: ["wrote final summary before terminal marker was captured"],
        delegatedTasks: [],
        finalVerification: "passed",
        commits: [],
        followUps: [],
      })}\n`,
    );

    expect(discoverRuntimeGuardianFindings({ now: 2, lookbackMs: 86_400_000 })).toEqual([]);
  });

  it("keeps terminal invalid-output findings when the durable summary is not a successful completion", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-runtime-guardian-project-"));
    const runDir = join(
      process.env.TCB_STATE_DIR ?? "",
      "loop-runs",
      "tmux-claude-bot",
      "run-invalid-output-blocked-summary",
    );
    mkdirSync(runDir, { recursive: true });
    const summaryPath = join(runDir, "supervisor-final-summary.json");
    const order = workOrder("run-invalid-output-blocked-summary", projectDir, summaryPath);
    writeLoopSupervisorWorkOrderState({
      workOrder: order,
      supervisorSession: "tmux_proj_loop-supervisor",
      status: "failed",
      now: 2,
      resultStatus: "invalid-output",
    });
    writeFileSync(
      summaryPath,
      `${JSON.stringify({
        status: "blocked",
        projectId: "tmux-claude-bot",
        actionsTaken: ["blocked before completion"],
        delegatedTasks: [],
        finalVerification: "failed",
        commits: [],
        followUps: ["retry after resolving the blocker"],
      })}\n`,
    );

    expect(discoverRuntimeGuardianFindings({ now: 2, lookbackMs: 86_400_000 })).toEqual([
      expect.objectContaining({
        kind: "terminal-invalid-output",
        runId: "run-invalid-output-blocked-summary",
      }),
    ]);
  });

  it("builds a repair prompt that prevents target-repo edits and PR handling", () => {
    const prompt = buildRuntimeGuardianRepairPrompt({
      repoPath: "/repo/tmux-claude-bot",
      repairBranch: "dev",
      mode: "fast-heal",
      findings: [finding({ projectPath: "/repo/geo-backend" })],
    });

    expect(prompt).toContain("Runtime Guardian (fast-heal)");
    expect(prompt).toContain("Do not edit target project repositories");
    expect(prompt).toContain("fix the bot WorkOrder verification profile or worktree policy");
    expect(prompt).toContain("Do not open a PR");
    expect(prompt).toContain("Use CodeGraph before grep/find");
    expect(prompt).toContain("pre-mutation review");
    expect(prompt).toContain("post-mutation review");
    expect(prompt).toContain(
      "AI review/eval may be used only through the existing Claude Code / Codex control surface",
    );
    expect(prompt).toContain("deterministic gates and system acceptance remain authoritative");
    expect(prompt).toContain("source=runtime-guardian");
  });
});
