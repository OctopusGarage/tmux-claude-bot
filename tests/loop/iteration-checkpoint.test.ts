import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkpointAcceptanceGate } from "../../src/core/loop/checkpoint-acceptance.js";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";
import {
  buildIterationCheckpointTemplate,
  iterationCheckpointPath,
  readIterationCheckpoint,
} from "../../src/core/loop/iteration-checkpoint.js";
import { defaultActiveDelegationPlanning } from "../../src/core/loop/planning.js";
import {
  runSupervisedSystemGateOutcome,
  systemGateProjectFromWorkOrder,
} from "../../src/core/loop/service.js";
import { writeLoopSupervisorReport } from "../../src/core/loop/supervisor-report.js";
import {
  buildLoopSupervisorFinalizationPrompt,
  buildLoopSupervisorPrompt,
  buildLoopSupervisorRevisionPrompt,
  buildLoopWorkOrder,
  type LoopWorkOrder,
} from "../../src/core/loop/work-order.js";

function fixture(): LoopWorkOrder {
  const config = parseLoopConfigYaml(`
projects:
  - id: app
    name: App
    path: /repo/app
    agent: codex
    schedule: "30 5 * * *"
    runner:
      kind: agent-supervised
    goal: Implement the confirmed task.
    maxRounds: 3
    targetScore: 90
    assessment:
      command: pnpm assess
    execution:
      agent: true
`);
  const project = config.projects[0];
  if (!project) throw new Error("missing fixture project");
  return {
    ...buildLoopWorkOrder({ config, project, scheduledAt: 1, runId: "checkpoint-test" }),
    finalSummaryPath: join(mkdtempSync(join(tmpdir(), "tcb-checkpoint-")), "final.json"),
    task: {
      kind: "active-delegated-task",
      sourceSession: "project-app",
      requirement: "Implement two verified behaviors.",
      requireReview: true,
      requireTests: true,
      requireCoverageReview: true,
      allowAiEval: false,
    },
    planning: {
      ...defaultActiveDelegationPlanning(),
      acceptanceCriteria: ["First behavior works", "Second behavior works"],
    },
  };
}

function save(workOrder: LoopWorkOrder, checkpoint: unknown): string {
  const path = iterationCheckpointPath(workOrder);
  if (!path) throw new Error("checkpoint not supported");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(checkpoint));
  return path;
}

function partial(workOrder: LoopWorkOrder) {
  const checkpoint = buildIterationCheckpointTemplate(workOrder);
  const item = checkpoint.items[0];
  if (!item) throw new Error("missing acceptance item");
  checkpoint.sequence = 1;
  checkpoint.repositoryRevision = "a".repeat(40);
  checkpoint.worktreeDirty = false;
  item.status = "reported-passed";
  item.evidence = [
    {
      source: "agent-reported",
      revision: checkpoint.repositoryRevision,
      command: "pnpm test -- first-behavior",
      result: "passed",
      artifact: "verification/first.txt",
    },
  ];
  checkpoint.nextAction = "Implement the second behavior.";
  return checkpoint;
}

function initRepo(): { repo: string; git: (args: string[]) => string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tcb-checkpoint-git-")));
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-b", "main"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  return { repo, git };
}

function runGitForRepo() {
  return ({ cwd, args }: { cwd: string; args: string[] }) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

function writeCommandVerification(
  workOrder: LoopWorkOrder,
  input: {
    revision: string;
    passed?: boolean;
    contractHash?: string;
    workOrderId?: string;
  },
): void {
  const checkpointPath = iterationCheckpointPath(workOrder);
  if (!checkpointPath) throw new Error("checkpoint not supported");
  const dir = join(dirname(checkpointPath), "command-verifications");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${Date.now()}-${randomUUID()}.json`),
    JSON.stringify({
      schemaVersion: 1,
      source: "system-command",
      workOrderId: input.workOrderId ?? workOrder.id,
      contractHash: input.contractHash ?? buildIterationCheckpointTemplate(workOrder).contractHash,
      revision: input.revision,
      commandHash: createHash("sha256").update("pnpm assess").digest("hex"),
      exitStatus: input.passed === false ? 1 : 0,
      passed: input.passed !== false,
      failures: [],
      score: null,
      startedAt: "2026-09-17T00:00:00.000Z",
      endedAt: "2026-09-17T00:00:01.000Z",
      outputHash: createHash("sha256").update("").digest("hex"),
    }),
  );
}

describe("iteration checkpoints", () => {
  it("requires system command verification before accepting a fully reported checkpoint", () => {
    const workOrder = fixture();
    const { repo, git } = initRepo();
    workOrder.projectPath = repo;
    const checkpoint = partial(workOrder);
    checkpoint.repositoryRevision = git(["rev-parse", "HEAD"]);
    for (const item of checkpoint.items) {
      item.status = "reported-passed";
      item.evidence = [
        {
          source: "agent-reported",
          revision: checkpoint.repositoryRevision,
          command: "pnpm assess",
          result: "passed",
          artifact: "assessment.json",
        },
      ];
    }
    save(workOrder, checkpoint);
    expect(checkpointAcceptanceGate(workOrder, runGitForRepo()).failures).toEqual([
      "checkpoint system verification artifact is missing or not passed for current revision",
    ]);
    writeCommandVerification(workOrder, { revision: checkpoint.repositoryRevision });
    expect(checkpointAcceptanceGate(workOrder, runGitForRepo())).toMatchObject({
      failures: [],
    });
  });

  it.each(["failed", "wrong-revision", "wrong-contract", "wrong-work-order"] as const)(
    "rejects %s system command verification for checkpoint acceptance",
    (scenario) => {
      const workOrder = fixture();
      const { repo, git } = initRepo();
      workOrder.projectPath = repo;
      const checkpoint = partial(workOrder);
      checkpoint.repositoryRevision = git(["rev-parse", "HEAD"]);
      for (const item of checkpoint.items) {
        item.status = "reported-passed";
        item.evidence = [
          {
            source: "agent-reported",
            revision: checkpoint.repositoryRevision,
            command: "pnpm assess",
            result: "passed",
            artifact: "assessment.json",
          },
        ];
      }
      save(workOrder, checkpoint);
      writeCommandVerification(workOrder, {
        revision: scenario === "wrong-revision" ? "b".repeat(40) : checkpoint.repositoryRevision,
        passed: scenario !== "failed",
        ...(scenario === "wrong-contract" ? { contractHash: "c".repeat(64) } : {}),
        ...(scenario === "wrong-work-order" ? { workOrderId: "other-work-order" } : {}),
      });
      expect(checkpointAcceptanceGate(workOrder, runGitForRepo()).failures).toEqual([
        "checkpoint system verification artifact is missing or not passed for current revision",
      ]);
    },
  );

  it("does not downgrade to legacy acceptance after an observed checkpoint is deleted", () => {
    const workOrder = fixture();
    const path = save(workOrder, partial(workOrder));
    expect(checkpointAcceptanceGate(workOrder, undefined).failures.length).toBeGreaterThan(0);
    unlinkSync(path);
    expect(checkpointAcceptanceGate(workOrder, undefined).failures).toEqual([
      "checkpoint required artifact is missing",
    ]);
  });

  it.each(["pending", "stale-head", "dirty", "wrong-root", "valid", "corrupt"])(
    "system acceptance checks a real repository: %s",
    (scenario) => {
      const workOrder = fixture();
      const repo = realpathSync(mkdtempSync(join(tmpdir(), "tcb-checkpoint-git-")));
      const git = (args: string[]) => {
        const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
        if (result.status !== 0) throw new Error(result.stderr);
        return result.stdout.trim();
      };
      git(["init", "-b", "main"]);
      git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ]);
      workOrder.projectPath = repo;
      const checkpoint = partial(workOrder);
      checkpoint.repositoryRevision = git(["rev-parse", "HEAD"]);
      for (const item of checkpoint.items) {
        item.status = scenario === "pending" ? "pending" : "reported-passed";
        item.evidence = [
          {
            source: "agent-reported",
            revision: checkpoint.repositoryRevision,
            command: "untrusted command must not execute",
            result: "passed",
            artifact: "result.txt",
          },
        ];
      }
      if (scenario === "stale-head") {
        git([
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "--allow-empty",
          "-m",
          "new revision",
        ]);
      }
      if (scenario === "dirty") writeFileSync(join(repo, "untracked.txt"), "owner work");
      if (scenario === "wrong-root") {
        workOrder.projectPath = join(repo, "subdir");
        mkdirSync(workOrder.projectPath);
        checkpoint.contractHash = buildIterationCheckpointTemplate(workOrder).contractHash;
      }
      save(workOrder, scenario === "corrupt" ? {} : checkpoint);
      if (scenario === "valid") {
        writeCommandVerification(workOrder, { revision: checkpoint.repositoryRevision });
      }
      const calls: string[][] = [];
      const gate = runSupervisedSystemGateOutcome({
        project: systemGateProjectFromWorkOrder(workOrder),
        workOrder,
        result: {
          status: "completed",
          output: "done",
          summary: {
            status: "completed",
            projectId: workOrder.projectId,
            actionsTaken: [],
            delegatedTasks: [],
            commits: [],
            followUps: [],
            finalVerification: "passed",
            planReview: {
              checklistCompleted: true,
              targetScoreMet: "not-applicable",
              stopConditionReached: true,
              overOptimizationAvoided: true,
              verificationCompleted: true,
              remainingRisks: [],
            },
          },
        },
        runCommand: () => {
          throw new Error("must not execute checkpoint commands");
        },
        runGit: ({ cwd, args }) => {
          calls.push(args);
          const result = spawnSync("git", args, { cwd, encoding: "utf8" });
          return {
            status: result.status ?? 1,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
          };
        },
      });
      expect(gate.result.status, JSON.stringify(gate)).toBe(
        scenario === "valid" ? "completed" : "supervisor-failed",
      );
      if (scenario === "valid") expect(gate.evidence.join(" ")).toContain("checkpoint repository");
      if (scenario === "wrong-root") expect(calls).toEqual([["rev-parse", "--show-toplevel"]]);
    },
  );

  it("uses the current independent verification command record for checkpoint acceptance", () => {
    const workOrder = fixture();
    const { repo, git } = initRepo();
    workOrder.projectPath = repo;
    workOrder.eval = { command: "pnpm assess", minScore: 90 };
    const checkpoint = partial(workOrder);
    checkpoint.repositoryRevision = git(["rev-parse", "HEAD"]);
    for (const item of checkpoint.items) {
      item.status = "reported-passed";
      item.evidence = [
        {
          source: "agent-reported",
          revision: checkpoint.repositoryRevision,
          command: "pnpm assess",
          result: "passed",
          artifact: "assessment.json",
        },
      ];
    }
    save(workOrder, checkpoint);
    const gate = runSupervisedSystemGateOutcome({
      project: systemGateProjectFromWorkOrder(workOrder),
      workOrder,
      result: {
        status: "completed",
        output: "done",
        summary: {
          status: "completed",
          projectId: workOrder.projectId,
          actionsTaken: [],
          delegatedTasks: [],
          commits: [],
          followUps: [],
          finalVerification: "passed",
          planReview: {
            checklistCompleted: true,
            targetScoreMet: "not-applicable",
            stopConditionReached: true,
            overOptimizationAvoided: true,
            verificationCompleted: true,
            remainingRisks: [],
          },
        },
      },
      runCommand: () => ({
        status: 0,
        stdout: JSON.stringify({ passed: true, score: 95 }),
        stderr: "",
      }),
      runGit: runGitForRepo(),
    });
    expect(gate.result.status, JSON.stringify(gate)).toBe("completed");
    expect(gate.evidence.join(" ")).toContain("matched a passed system command artifact");
  });
  it("preserves partial progress without requiring a final summary", () => {
    const workOrder = fixture();
    const checkpoint = partial(workOrder);
    save(workOrder, checkpoint);
    expect(readIterationCheckpoint(workOrder)).toMatchObject({
      status: "available",
      checkpoint: {
        sequence: 1,
        items: [{ status: "reported-passed" }, { status: "pending" }],
        nextAction: "Implement the second behavior.",
      },
    });
  });

  it("keeps acceptance IDs stable and binds scope changes to a new contract", () => {
    const workOrder = fixture();
    const original = buildIterationCheckpointTemplate(workOrder);
    const reordered = Object.fromEntries(Object.entries(workOrder).reverse()) as LoopWorkOrder;
    expect(buildIterationCheckpointTemplate(reordered)).toEqual(original);
    const changed = {
      ...workOrder,
      blockedActions: [...workOrder.blockedActions, "dependency-updates"],
    };
    expect(buildIterationCheckpointTemplate(changed).contractHash).not.toBe(original.contractHash);
    save(changed, partial(workOrder));
    expect(readIterationCheckpoint(changed)).toMatchObject({
      status: "invalid",
      reason: "contract-mismatch",
    });
  });

  it.each(["id", "projectId", "projectPath", "goal"] as const)(
    "rejects reuse when %s changes",
    (field) => {
      const workOrder = fixture();
      save(workOrder, partial(workOrder));
      expect(readIterationCheckpoint({ ...workOrder, [field]: "different" }).status).toBe(
        "invalid",
      );
    },
  );

  it.each([
    "missing-item",
    "duplicate-item",
    "unknown-item",
    "stale-revision",
    "system-provenance",
    "missing-evidence",
    "dirty-passed",
    "future-version",
    "invalid-sequence",
    "unknown-field",
  ])("rejects %s rather than trusting progress", (fault) => {
    const workOrder = fixture();
    const value = partial(workOrder);
    const item = value.items[0];
    if (!item) throw new Error("missing item");
    if (fault === "missing-item") value.items.pop();
    if (fault === "duplicate-item") value.items.push(item);
    if (fault === "unknown-item") item.id = "unknown";
    if (fault === "stale-revision") value.repositoryRevision = "b".repeat(40);
    if (fault === "system-provenance") {
      const evidence = item.evidence[0];
      if (!evidence) throw new Error("missing evidence");
      Reflect.set(evidence, "source", "system");
    }
    if (fault === "missing-evidence") item.evidence = [];
    if (fault === "dirty-passed") value.worktreeDirty = true;
    if (fault === "future-version") Reflect.set(value, "schemaVersion", 2);
    if (fault === "invalid-sequence") value.sequence = 0;
    if (fault === "unknown-field") Reflect.set(value, "verified", true);
    save(workOrder, value);
    expect(readIterationCheckpoint(workOrder).status).toBe("invalid");
  });

  it("distinguishes absent, corrupt and oversized files", () => {
    const workOrder = fixture();
    expect(readIterationCheckpoint(workOrder)).toEqual({ status: "absent" });
    const path = save(workOrder, {});
    writeFileSync(path, "{");
    expect(readIterationCheckpoint(workOrder)).toMatchObject({
      status: "invalid",
      reason: "unreadable-checkpoint",
    });
    writeFileSync(path, " ".repeat(1_048_577));
    expect(readIterationCheckpoint(workOrder)).toMatchObject({
      status: "invalid",
      reason: "checkpoint-too-large",
    });
  });

  it("does not enable checkpoints for other families or workspaces", () => {
    const workOrder = fixture();
    const otherFamily = { ...workOrder };
    delete otherFamily.task;
    expect(iterationCheckpointPath(otherFamily)).toBeNull();
    expect(readIterationCheckpoint(otherFamily)).toEqual({ status: "absent" });
    expect(
      iterationCheckpointPath({
        ...workOrder,
        workspace: { root: "/workspace", repositories: [] },
      }),
    ).toBeNull();
    expect(buildLoopSupervisorPrompt(otherFamily)).not.toContain("Iteration checkpoint");
  });

  it("rejects a passed item that also contains unresolved failed evidence", () => {
    const workOrder = fixture();
    const value = partial(workOrder);
    const item = value.items[0];
    const evidence = item?.evidence[0];
    if (!item || !evidence) throw new Error("missing evidence");
    item.evidence.push({ ...evidence, command: "pnpm test -- regression", result: "failed" });
    save(workOrder, value);
    expect(readIterationCheckpoint(workOrder).status).toBe("invalid");
  });

  it("rejects directories and symlinks as checkpoint input", () => {
    const directoryOrder = fixture();
    const directoryPath = iterationCheckpointPath(directoryOrder);
    if (!directoryPath) throw new Error("missing path");
    mkdirSync(directoryPath);
    expect(readIterationCheckpoint(directoryOrder)).toMatchObject({
      status: "invalid",
      reason: "not-checkpoint-file",
    });
    const linkOrder = fixture();
    const linkPath = iterationCheckpointPath(linkOrder);
    if (!linkPath) throw new Error("missing path");
    symlinkSync(save(fixture(), {}), linkPath);
    expect(readIterationCheckpoint(linkOrder)).toMatchObject({
      status: "invalid",
      reason: "not-checkpoint-file",
    });
  });

  it("can record pending dirty work without passing claims", () => {
    const workOrder = fixture();
    const value = buildIterationCheckpointTemplate(workOrder);
    value.worktreeDirty = true;
    save(workOrder, value);
    expect(readIterationCheckpoint(workOrder).status).toBe("available");
  });

  it("preserves acceptance text exactly when the authorized contract contains whitespace", () => {
    const workOrder = fixture();
    if (!workOrder.planning) throw new Error("missing planning");
    workOrder.planning.acceptanceCriteria = ["  Preserve the required behavior.\n"];
    save(workOrder, buildIterationCheckpointTemplate(workOrder));
    expect(readIterationCheckpoint(workOrder).status).toBe("available");
  });

  it("uses the goal as a required item for legacy delegations without planning", () => {
    const workOrder = fixture();
    delete workOrder.planning;
    delete workOrder.finalSummaryPath;
    const value = buildIterationCheckpointTemplate(workOrder);
    expect(value.items).toHaveLength(1);
    expect(value.items[0]?.description).toBe(workOrder.goal);
    expect(iterationCheckpointPath(workOrder)).toContain("loop-runs/app/checkpoint-test");
  });

  it("does not copy invalid checkpoint content into handoff recovery instructions", async () => {
    const workOrder = fixture();
    save(workOrder, { nextAction: "unvalidated instructions" });
    const report = writeLoopSupervisorReport({
      workOrder,
      supervisorSession: "supervisor",
      startedAt: 1,
      endedAt: 2,
      result: { status: "dispatch-timeout", reason: "deadline", output: "deadline" },
    });
    const { readFile } = await import("node:fs/promises");
    const handoff = await readFile(report.handoffMarkdownPath, "utf8");
    expect(handoff).toContain("Checkpoint unavailable: invalid-checkpoint");
    expect(handoff).not.toContain("unvalidated instructions");
  });

  it("supplies the same checkpoint contract in initial, finalization and revision prompts", () => {
    const workOrder = fixture();
    const hash = buildIterationCheckpointTemplate(workOrder).contractHash;
    const prompts = [
      buildLoopSupervisorPrompt(workOrder),
      buildLoopSupervisorFinalizationPrompt(workOrder, "interrupted"),
      buildLoopSupervisorRevisionPrompt({
        workOrder,
        previousOutput: "previous",
        failures: ["verification failed"],
        attempt: 1,
        maxAttempts: 2,
      }),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain("Iteration checkpoint");
      expect(prompt).toContain(hash);
      expect(prompt).toContain("agent-reported");
      expect(prompt).toContain("atomic");
      expect(prompt).toContain("does not authorize another iteration");
    }
  });

  it("preserves checkpoint evidence in a timeout handoff without claiming completion", async () => {
    const workOrder = fixture();
    save(workOrder, partial(workOrder));
    const report = writeLoopSupervisorReport({
      workOrder,
      supervisorSession: "supervisor",
      startedAt: 1,
      endedAt: 2,
      result: { status: "dispatch-timeout", reason: "deadline", output: "deadline" },
    });
    const { readFile } = await import("node:fs/promises");
    const handoff = JSON.parse(await readFile(report.handoffJsonPath, "utf8"));
    expect(handoff.status).toBe("dispatch-timeout");
    expect(handoff.progress.finalVerification).toBe("not-available");
    expect(handoff.progress.iterationCheckpoint).toMatchObject({
      status: "available",
      checkpoint: { items: [{ status: "reported-passed" }, { status: "pending" }] },
    });
    expect(handoff.nextAgent.resumeFrom).toContain(iterationCheckpointPath(workOrder));
    expect(await readFile(report.handoffMarkdownPath, "utf8")).toContain(
      "Agent-reported progress; not system acceptance",
    );
  });
});
