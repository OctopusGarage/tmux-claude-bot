import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recoverInvalidOutputFromFinalSummary,
  recoverInvalidOutputFromFinalSummaryAsync,
} from "../../src/core/loop/final-summary-recovery.js";
import {
  buildIterationCheckpointTemplate,
  checkpointProgressFingerprint,
  iterationCheckpointPath,
} from "../../src/core/loop/iteration-checkpoint.js";
import {
  runLoopSupervisedProjectAsync,
  runLoopSupervisorRevisionAsync,
  type SupervisorDispatchRequest,
} from "../../src/core/loop/supervised-runner.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tcb-continuation-")));
  directories.push(dir);
  const repo = join(dir, "repo");
  const init = spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
  expect(init.status).toBe(0);
  const runGit = ({ cwd, args }: { cwd: string; args: string[] }) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  expect(
    runGit({
      cwd: repo,
      args: [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
    }).status,
  ).toBe(0);
  const workOrder: LoopWorkOrder = {
    id: "continuation-run",
    projectId: "app",
    projectName: "App",
    projectPath: repo,
    scheduledAt: 1,
    agent: "codex",
    goal: "Complete the confirmed task.",
    maxRounds: 3,
    targetScore: 90,
    runner: { kind: "agent-supervised", timeoutMs: 10000, requireConfirmation: false },
    allowedActions: ["tests"],
    blockedActions: [],
    skills: { approved: [] },
    preflight: { commands: [], repair: { agent: false } },
    assessment: { command: "pnpm assess" },
    execution: { agent: true },
    recovery: { agent: false, dirtyWorktree: false, maxAttempts: 1 },
    commitPolicy: { enabled: false, perRound: true },
    task: {
      kind: "active-delegated-task",
      sourceSession: "project-app",
      requirement: "Finish.",
      requireReview: true,
      requireTests: true,
      requireCoverageReview: true,
      allowAiEval: false,
    },
    requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:continuation-run]",
    finalSummaryPath: join(dir, "final.json"),
  };
  const checkpointPath = iterationCheckpointPath(workOrder);
  if (checkpointPath === null) throw new Error("missing checkpoint path");
  function checkpoint(sequence: number) {
    const value = buildIterationCheckpointTemplate(workOrder);
    value.sequence = sequence;
    value.repositoryRevision = runGit({ cwd: repo, args: ["rev-parse", "HEAD"] }).stdout.trim();
    value.worktreeDirty =
      runGit({ cwd: repo, args: ["status", "--porcelain"] }).stdout.trim() !== "";
    writeFileSync(checkpointPath ?? "missing", JSON.stringify(value));
    return value;
  }
  return { workOrder, checkpoint, checkpointPath, runGit, dir };
}
const partial = { status: 0, stdout: "Completed one slice; more work remains.", stderr: "" };
function terminal(status = "completed") {
  return {
    status: 0,
    stderr: "",
    stdout: `[LOOP_SUPERVISOR_DONE:continuation-run]\n${JSON.stringify({ status, projectId: "app", actionsTaken: [], delegatedTasks: [], finalVerification: "passed", commits: [], followUps: [] })}`,
  };
}

describe("partial delegation continuation", () => {
  it("does not overwrite an interrupted evidence claim or grant another turn", async () => {
    const f = fixture();
    const checkpoint = f.checkpoint(1);
    const evidenceDir = join(f.dir, "continuation-evidence");
    mkdirSync(evidenceDir);
    const claim = join(evidenceDir, `${checkpointProgressFingerprint(checkpoint)}.json`);
    writeFileSync(claim, "{");
    const dispatch = vi.fn(async () => {
      f.checkpoint(2);
      return partial;
    });
    const result = await runLoopSupervisedProjectAsync({
      ...f,
      supervisorSession: "worker",
      timeoutMs: 10000,
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.output).toContain("repeated checkpoint evidence");
    expect(result.finalSummaryRecovery).toBe("disabled");
    expect(readFileSync(claim, "utf8")).toBe("{");
    expect(
      JSON.parse(readFileSync(join(f.dir, "delegation-budget.json"), "utf8")).continuationsUsed,
    ).toBe(0);
  });

  it("ignores evidence ordering and duplication when identifying a report", () => {
    const f = fixture();
    const first = f.checkpoint(1);
    const item = first.items[0];
    if (!item || !first.repositoryRevision) throw new Error("missing checkpoint item");
    const evidence = {
      source: "agent-reported" as const,
      revision: first.repositoryRevision,
      command: "pnpm test",
      result: "failed" as const,
      artifact: "test.log",
    };
    item.evidence = [evidence, { ...evidence, command: "pnpm lint" }];
    const next = structuredClone(first);
    next.sequence++;
    next.nextAction = "Rephrased next step";
    const nextItem = next.items[0];
    if (!nextItem) throw new Error("missing item");
    nextItem.evidence.reverse();
    nextItem.evidence.push(evidence);
    expect(checkpointProgressFingerprint(next)).toBe(checkpointProgressFingerprint(first));
    nextItem.evidence[0] = { ...evidence, result: "passed" };
    expect(checkpointProgressFingerprint(next)).not.toBe(checkpointProgressFingerprint(first));
  });

  it("rejects a report cycle after an intervening different report", async () => {
    const f = fixture();
    f.workOrder.maxRounds = 10;
    let sequence = 0;
    const dispatch = vi.fn(async () => {
      const checkpoint = f.checkpoint(++sequence);
      const item = checkpoint.items[0];
      if (!item || !checkpoint.repositoryRevision) throw new Error("missing checkpoint item");
      item.evidence = [
        {
          source: "agent-reported",
          revision: checkpoint.repositoryRevision,
          command: sequence === 2 ? "pnpm lint" : "pnpm test",
          result: "failed",
          artifact: "check.log",
        },
      ];
      writeFileSync(f.checkpointPath, JSON.stringify(checkpoint));
      return partial;
    });
    const result = await runLoopSupervisedProjectAsync({
      ...f,
      supervisorSession: "worker",
      timeoutMs: 10000,
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(result.output).toContain("repeated checkpoint evidence");
  });

  it("rejects repeated evidence despite increasing sequences and survives checkpoint removal", async () => {
    const f = fixture();
    f.workOrder.maxRounds = 10;
    let sequence = 0;
    const dispatch = vi.fn(async () => {
      const checkpoint = f.checkpoint(++sequence);
      checkpoint.nextAction = `Rephrased action ${sequence}`;
      writeFileSync(f.checkpointPath, JSON.stringify(checkpoint));
      return partial;
    });
    const input = { ...f, supervisorSession: "worker", timeoutMs: 10000, dispatch };
    const first = await runLoopSupervisedProjectAsync(input);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(first.output).toContain("repeated checkpoint evidence");
    expect(first.finalSummaryRecovery).toBe("disabled");
    rmSync(f.checkpointPath);
    const resumed = await runLoopSupervisedProjectAsync(input);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(resumed.output).toContain("repeated checkpoint evidence");
    expect(
      JSON.parse(readFileSync(join(f.dir, "delegation-budget.json"), "utf8")).continuationsUsed,
    ).toBe(1);
  });

  it("ignores an earlier summary while a revision makes partial progress", async () => {
    const f = fixture();
    writeFileSync(join(f.dir, "final.json"), terminal().stdout.split("\n")[1] ?? "");
    let calls = 0;
    const dispatch = vi.fn(async () => {
      if (++calls === 1) {
        f.checkpoint(1);
        return partial;
      }
      return terminal("blocked");
    });
    const result = await runLoopSupervisorRevisionAsync({
      ...f,
      supervisorSession: "worker",
      timeoutMs: 10000,
      dispatch,
      failures: ["required behavior failed"],
      attempt: 1,
      maxAttempts: 2,
      previousOutput: "old completed claim",
    });
    expect(result.status).toBe("blocked");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not recover an unchanged old summary after a failed current dispatch", async () => {
    const f = fixture();
    const summary = terminal().stdout.split("\n")[1] ?? "";
    writeFileSync(join(f.dir, "final.json"), summary);
    const dispatch = vi.fn(async () => ({
      status: 1,
      stdout: "",
      stderr: "current dispatch failed",
    }));
    const result = await runLoopSupervisedProjectAsync({
      ...f,
      supervisorSession: "worker",
      timeoutMs: 10000,
      dispatch,
    });
    expect(recoverInvalidOutputFromFinalSummary(f.workOrder, result).status).toBe(
      "dispatch-failed",
    );
    expect(
      (
        await recoverInvalidOutputFromFinalSummaryAsync(f.workOrder, result, {
          timeoutMs: 5,
          intervalMs: 1,
        })
      ).status,
    ).toBe("dispatch-failed");
    expect(readFileSync(join(f.dir, "final.json"), "utf8")).toBe(summary);
    writeFileSync(join(f.dir, "fresh.json"), summary);
    renameSync(join(f.dir, "fresh.json"), join(f.dir, "final.json"));
    expect(recoverInvalidOutputFromFinalSummary(f.workOrder, result).status).toBe("completed");
  });

  it("rejects an unchanged old summary after the current attempt times out", async () => {
    const f = fixture();
    writeFileSync(join(f.dir, "final.json"), terminal().stdout.split("\n")[1] ?? "");
    const running = runLoopSupervisedProjectAsync({
      ...f,
      supervisorSession: "worker",
      timeoutMs: 10,
      dispatch: async () => new Promise(() => {}),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await running;
    expect(result.status).toBe("dispatch-timeout");
    expect(recoverInvalidOutputFromFinalSummary(f.workOrder, result).status).toBe(
      "dispatch-timeout",
    );
  });

  it("accepts an identical summary atomically rewritten during the current turn", async () => {
    const f = fixture();
    const summary = terminal().stdout.split("\n")[1] ?? "";
    writeFileSync(join(f.dir, "final.json"), summary);
    const dispatch = vi.fn(async () => {
      writeFileSync(join(f.dir, "fresh.json"), summary);
      renameSync(join(f.dir, "fresh.json"), join(f.dir, "final.json"));
      return partial;
    });
    expect(
      (
        await runLoopSupervisedProjectAsync({
          ...f,
          supervisorSession: "worker",
          timeoutMs: 10000,
          dispatch,
        })
      ).status,
    ).toBe("completed");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(["symlink", "directory", "oversized", "malformed"])(
    "does not recover a fresh but invalid summary artifact: %s",
    async (kind) => {
      const f = fixture();
      const path = join(f.dir, "final.json");
      const dispatch = vi.fn(async () => {
        if (kind === "symlink") {
          const target = join(f.dir, "untrusted.json");
          writeFileSync(target, terminal().stdout.split("\n")[1] ?? "");
          symlinkSync(target, path);
        } else if (kind === "directory") mkdirSync(path);
        else if (kind === "oversized") writeFileSync(path, " ".repeat(1_048_577));
        else writeFileSync(path, "{");
        return { status: 1, stdout: "", stderr: "transport failed" };
      });
      const result = await runLoopSupervisedProjectAsync({
        ...f,
        supervisorSession: "worker",
        timeoutMs: 10000,
        dispatch,
      });
      expect(recoverInvalidOutputFromFinalSummary(f.workOrder, result).status).toBe(
        "dispatch-failed",
      );
    },
  );

  it("repeats the same prompt and session using fresh durable progress", async () => {
    const f = fixture();
    const prompts: string[] = [];
    const dispatch = vi.fn(async (request: SupervisorDispatchRequest) => {
      prompts.push(request.prompt);
      if (prompts.length < 3) {
        writeFileSync(join(f.workOrder.projectPath, "slice.txt"), `slice ${prompts.length}`);
        expect(f.runGit({ cwd: f.workOrder.projectPath, args: ["add", "slice.txt"] }).status).toBe(
          0,
        );
        expect(
          f.runGit({
            cwd: f.workOrder.projectPath,
            args: [
              "-c",
              "user.name=Test",
              "-c",
              "user.email=test@example.invalid",
              "commit",
              "-m",
              `slice ${prompts.length}`,
            ],
          }).status,
        ).toBe(0);
        f.checkpoint(prompts.length);
        return partial;
      }
      return terminal();
    });
    const result = await runLoopSupervisedProjectAsync({
      ...f,
      supervisorSession: "isolated-worker",
      timeoutMs: 10000,
      resetBeforeWorkOrder: "clear",
      dispatch,
    });
    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(3);
    expect(new Set(prompts).size).toBe(1);
    expect(dispatch.mock.calls.map(([request]) => request.session)).toEqual([
      "isolated-worker",
      "isolated-worker",
      "isolated-worker",
    ]);
    expect(
      dispatch.mock.calls.slice(1).every(([request]) => request.contextReset === undefined),
    ).toBe(true);
    expect(
      JSON.parse(readFileSync(join(f.dir, "delegation-budget.json"), "utf8")).continuationsUsed,
    ).toBe(2);
    expect(
      JSON.parse(readFileSync(join(f.dir, "checkpoint-required.json"), "utf8")).contractHash,
    ).toBe(buildIterationCheckpointTemplate(f.workOrder).contractHash);
  });

  it.each([
    "blocked",
    "stale",
    "dirty-mismatch",
    "wrong-root",
    "invalid",
    "unchanged",
    "missing-adapter",
  ])("stops before another worker for %s progress", async (scenario) => {
    const f = fixture();
    if (scenario === "unchanged") f.checkpoint(1);
    const dispatch = vi.fn(async () => {
      const value = f.checkpoint(1);
      if (scenario === "blocked") for (const item of value.items) item.status = "blocked";
      if (scenario === "stale") value.repositoryRevision = "a".repeat(40);
      if (scenario === "dirty-mismatch")
        writeFileSync(join(f.workOrder.projectPath, "untracked"), "changed");
      writeFileSync(f.checkpointPath, scenario === "invalid" ? "{" : JSON.stringify(value));
      return partial;
    });
    const runGit =
      scenario === "wrong-root" ? () => ({ status: 0, stdout: f.dir, stderr: "" }) : f.runGit;
    const result = await runLoopSupervisedProjectAsync({
      workOrder: f.workOrder,
      ...(scenario === "missing-adapter" ? {} : { runGit }),
      supervisorSession: "worker",
      timeoutMs: 10000,
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.status).not.toBe("completed");
    expect(result.finalSummaryRecovery).toBe("disabled");
    expect(result.output).toContain("continuation");
  });

  it("caps partial turns across initial and revision execution", async () => {
    const f = fixture();
    f.workOrder.maxRounds = 2;
    let sequence = 0;
    const dispatch = vi.fn(async () => {
      f.checkpoint(++sequence);
      return partial;
    });
    const input = { ...f, supervisorSession: "worker", timeoutMs: 10000, dispatch };
    const result = await runLoopSupervisedProjectAsync(input);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.output).toContain("continuation budget exhausted");
    const revision = await runLoopSupervisorRevisionAsync({
      ...input,
      failures: ["verification"],
      attempt: 1,
      maxAttempts: 2,
      previousOutput: "",
    });
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(revision.output).toContain("continuation budget exhausted");
  });

  it("stops on replayed progress after a resumed initial turn", async () => {
    const f = fixture();
    const dispatch = vi.fn(async () => {
      f.checkpoint(1);
      return partial;
    });
    const input = { ...f, supervisorSession: "worker", timeoutMs: 10000, dispatch };
    await runLoopSupervisedProjectAsync(input);
    expect(dispatch).toHaveBeenCalledTimes(2);
    rmSync(f.checkpointPath);
    await runLoopSupervisedProjectAsync(input);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("does not overwrite corrupt checkpoint requirement state to grant a turn", async () => {
    const f = fixture();
    writeFileSync(join(f.dir, "checkpoint-required.json"), "{}");
    const dispatch = vi.fn(async () => {
      f.checkpoint(1);
      return partial;
    });
    const result = await runLoopSupervisedProjectAsync({
      ...f,
      supervisorSession: "worker",
      timeoutMs: 10000,
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.output).toContain("checkpoint requirement invalid");
    expect(readFileSync(join(f.dir, "checkpoint-required.json"), "utf8")).toBe("{}");
  });

  it("keeps cancellation authoritative during a continued turn", async () => {
    const f = fixture();
    const controller = new AbortController();
    let sequence = 0;
    const dispatch = vi.fn(async () => {
      f.checkpoint(++sequence);
      if (sequence === 2) controller.abort("operator cancelled");
      return partial;
    });
    const result = await runLoopSupervisedProjectAsync({
      ...f,
      supervisorSession: "worker",
      timeoutMs: 10000,
      cancelSignal: controller.signal,
      dispatch,
    });
    expect(result.status).toBe("cancelled");
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(readFileSync(join(f.dir, "delegation-budget.json"), "utf8")).continuationsUsed,
    ).toBe(1);
  });

  it("does not grant continuation after the original deadline", async () => {
    const f = fixture();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const dispatch = vi.fn(async () => {
      f.checkpoint(1);
      now.mockReturnValue(11001);
      return partial;
    });
    const result = await runLoopSupervisedProjectAsync({
      ...f,
      supervisorSession: "worker",
      timeoutMs: 10000,
      dispatch,
    });
    expect(result.status).toBe("dispatch-timeout");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.finalSummaryRecovery).toBe("disabled");
  });

  it("continues accurately reported dirty partial work", async () => {
    const f = fixture();
    const prompts: string[] = [];
    const dispatch = vi.fn(async (request: SupervisorDispatchRequest) => {
      prompts.push(request.prompt);
      if (prompts.length === 2) return terminal();
      writeFileSync(join(f.workOrder.projectPath, "work-in-progress"), "unfinished");
      f.checkpoint(1);
      return partial;
    });
    const result = await runLoopSupervisedProjectAsync({
      ...f,
      supervisorSession: "worker",
      timeoutMs: 10000,
      dispatch,
    });
    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(prompts[0]);
  });

  it("finalizes an all-passed checkpoint without consuming a continuation", async () => {
    const f = fixture();
    const prompts: string[] = [];
    const dispatch = vi.fn(async (request: SupervisorDispatchRequest) => {
      prompts.push(request.prompt);
      if (prompts.length === 2) return terminal();
      const value = f.checkpoint(1);
      for (const item of value.items) {
        item.status = "reported-passed";
        item.evidence = [
          {
            source: "agent-reported",
            revision: value.repositoryRevision ?? "",
            command: "pnpm test",
            result: "passed",
            artifact: "test.log",
          },
        ];
      }
      writeFileSync(f.checkpointPath, JSON.stringify(value));
      return partial;
    });
    const result = await runLoopSupervisedProjectAsync({
      ...f,
      supervisorSession: "worker",
      timeoutMs: 10000,
      dispatch,
    });
    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toBe(prompts[0]);
    expect(
      JSON.parse(readFileSync(join(f.dir, "delegation-budget.json"), "utf8")).continuationsUsed,
    ).toBe(0);
  });

  it("preserves legacy finalization and explicit terminal outcomes", async () => {
    const f = fixture();
    const dispatch = vi.fn(async () => partial);
    await runLoopSupervisedProjectAsync({
      ...f,
      supervisorSession: "worker",
      timeoutMs: 10000,
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    const terminalDispatch = vi.fn(async () => {
      f.checkpoint(1);
      return terminal("blocked");
    });
    expect(
      (
        await runLoopSupervisedProjectAsync({
          ...f,
          supervisorSession: "worker",
          timeoutMs: 10000,
          dispatch: terminalDispatch,
        })
      ).status,
    ).toBe("blocked");
    expect(terminalDispatch).toHaveBeenCalledTimes(1);
  });
});
