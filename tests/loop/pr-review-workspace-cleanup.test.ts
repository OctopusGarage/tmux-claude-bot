import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { quarantineLoopExecution } from "../../src/core/loop/execution-quarantine.js";
import { prReviewSourceFingerprint } from "../../src/core/loop/ralph-pr-review.js";
import type { LoopGitInvocation, LoopRunCommandResult } from "../../src/core/loop/run.js";
import { writeLoopSupervisorWorkerLeaseState } from "../../src/core/loop/supervisor-pool.js";
import { reconcileTerminalSupervisorResources } from "../../src/core/loop/supervisor-resource-reconciliation.js";
import { writeLoopSupervisorWorkOrderState } from "../../src/core/loop/supervisor-state.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

const NOW = Date.now();
const originalState = process.env.TCB_STATE_DIR;
const roots: string[] = [];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
const runGit = ({ cwd, args }: LoopGitInvocation): LoopRunCommandResult => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
function git(cwd: string, ...args: string[]) {
  const result = runGit({ cwd, args });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function fixture(status: "completed" | "failed" | "cancelled" = "completed") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tcb-pr-cleanup-")));
  roots.push(root);
  process.env.TCB_STATE_DIR = root;
  const runDir = join(root, "loop-runs", "project", "run-1");
  const prDir = join(runDir, "pr-reviews", "7");
  const passDir = join(prDir, randomUUID());
  const snapshot = join(passDir, "worktree");
  mkdirSync(snapshot, { recursive: true });
  git(snapshot, "init", "-q", "-b", "main");
  writeFileSync(join(snapshot, "source.txt"), "original source\n");
  git(snapshot, "add", ".");
  git(
    snapshot,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const head = git(snapshot, "rev-parse", "HEAD");
  git(snapshot, "checkout", "--detach", "-q");
  const order = {
    id: "run-1",
    projectId: "project",
    projectName: "Fixture",
    projectPath: join(root, "loop-worktrees", "project", "run-1"),
    scheduledAt: NOW,
    requiredFinalMarker: "[DONE]",
    agent: "codex",
    finalSummaryPath: join(runDir, "supervisor-final-summary.json"),
    task: {
      kind: "repository-pull-request-review",
      repo: "fixture/project",
      reviewer: { kind: "ralphworks" },
      consecutivePasses: 1,
    },
    commitPolicy: { enabled: false, perRound: false },
    executionIsolation: {
      mode: "supervised-worker",
      expectedWorktree: join(root, "loop-worktrees", "project", "run-1"),
      worktreeIsolation: "isolated",
      preparedBy: "system-git-worktree",
      contextReset: "compact",
      cleanup: { success: "release-worker", failure: "retain-for-ttl", retainFailureForHours: 0 },
    },
  } as LoopWorkOrder;
  const snapshotOrder = {
    ...order,
    id: "run-1:pr:7:1:fixture",
    projectPath: snapshot,
    finalSummaryPath: join(passDir, "supervisor-final-summary.json"),
  };
  delete snapshotOrder.executionIsolation;
  writeLoopSupervisorWorkOrderState({
    workOrder: order,
    supervisorSession: "supervisor",
    status,
    now: NOW,
    resultStatus: status === "failed" ? "dispatch-timeout" : status,
  });
  json(join(runDir, "system-gate.json"), {
    workOrderId: order.id,
    projectId: order.projectId,
    accepted: status === "completed",
  });
  const parentDigest = digest(JSON.stringify(order));
  json(join(passDir, "attempt.json"), {
    workOrderSha256: parentDigest,
    sequence: 1,
    number: 7,
    repository: "fixture/project",
  });
  json(join(passDir, "work-order.json"), snapshotOrder);
  const external = join(passDir, "external-execution");
  mkdirSync(join(external, "ralph-state"), { recursive: true });
  writeFileSync(join(external, "task.md"), "Review fixture source.");
  const inputSha = digest(readFileSync(join(external, "task.md")));
  json(join(external, "reservation.json"), {
    workOrderId: snapshotOrder.id,
    workOrderSha256: digest(JSON.stringify(snapshotOrder)),
    invocationId: "invocation",
    taskInputSha256: inputSha,
    workspace: snapshot,
    baseHead: head,
  });
  const receipt = {
    invocationId: "invocation",
    taskInputSha256: inputSha,
    workspace: { path: snapshot, baseHead: head, head },
    result: { status: "completed" },
  };
  json(join(external, "receipt.json"), receipt);
  json(join(external, "process.json"), { status: 0 });
  json(join(external, "accepted-receipt.json"), {
    invocationId: "invocation",
    taskInputSha256: inputSha,
    receiptSha256: digest(JSON.stringify(receipt)),
    archivePath: join(external, "ralph-state"),
  });
  const report = {
    verdict: "clean",
    findings: [],
    revision: { baseSha: head, headSha: head, diffSha256: digest("") },
  };
  json(join(snapshot, "CODE_REVIEW.json"), report);
  json(join(passDir, "accepted-review.json"), {
    schemaVersion: 1,
    workOrderSha256: parentDigest,
    sequence: 1,
    number: 7,
    repository: "fixture/project",
    revision: report.revision,
    report,
    snapshotOrder,
    sourceSha256: prReviewSourceFingerprint(snapshot),
  });
  return { root, runDir, prDir, passDir, snapshot, order, snapshotOrder, head, external, report };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalState === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalState;
});

describe("terminal PR review snapshot cleanup", () => {
  it.each(["empty", "nonempty", "symlink"] as const)(
    "accepts only unused real legacy state directories: %s",
    async (kind) => {
      const f = fixture();
      const legacyState = join(f.snapshot, ".ralph");
      if (kind === "symlink") {
        const target = join(f.root, "legacy-state-target");
        mkdirSync(target);
        symlinkSync(target, legacyState);
      } else {
        mkdirSync(legacyState);
        if (kind === "nonempty") writeFileSync(join(legacyState, "state.json"), "{}");
      }
      await reconcileTerminalSupervisorResources({ now: NOW + 1000, runGit });
      expect(existsSync(f.snapshot)).toBe(kind !== "empty");
      if (kind === "empty")
        expect(existsSync(join(f.passDir, "workspace-cleanup.json"))).toBe(true);
    },
  );

  it("archives the source and report after completion even when the parent worktree is gone", async () => {
    const f = fixture();
    const result = await reconcileTerminalSupervisorResources({ now: NOW + 1000, runGit });
    expect(existsSync(f.snapshot)).toBe(false);
    expect(result.removedTerminalWorktrees).toBe(1);
    const receipt = JSON.parse(readFileSync(join(f.passDir, "workspace-cleanup.json"), "utf8"));
    const archive = JSON.parse(gunzipSync(readFileSync(receipt.archivePath)).toString());
    expect(git(archive.objectStore, "show", `${archive.headRef}:source.txt`)).toBe(
      "original source",
    );
    const report = archive.files.find((file: { path: string }) => file.path === "CODE_REVIEW.json");
    expect(JSON.parse(Buffer.from(report.data, "base64").toString())).toEqual(f.report);
    expect(JSON.parse(readFileSync(join(f.passDir, "CODE_REVIEW.json"), "utf8"))).toEqual(f.report);
    expect(existsSync(join(f.passDir, "accepted-review.json"))).toBe(true);
    expect(existsSync(join(f.external, "receipt.json"))).toBe(true);
    expect(existsSync(join(f.prDir, "active"))).toBe(false);
    expect(
      (await reconcileTerminalSupervisorResources({ now: NOW + 1001, runGit }))
        .removedTerminalWorktrees,
    ).toBe(0);
  });

  it.each(["failed", "cancelled"] as const)("archives released %s snapshots", async (status) => {
    const f = fixture(status);
    await reconcileTerminalSupervisorResources({ now: NOW + 1000, runGit });
    expect(existsSync(f.snapshot)).toBe(false);
  });

  it.each(["queued", "in-flight", "needs-revision"] as const)(
    "retains %s snapshots",
    async (status) => {
      const f = fixture();
      writeLoopSupervisorWorkOrderState({
        workOrder: f.order,
        supervisorSession: "supervisor",
        status,
        now: NOW,
      });
      await reconcileTerminalSupervisorResources({ now: NOW + 1000, runGit });
      expect(existsSync(f.snapshot)).toBe(true);
    },
  );

  it.each([
    "active lock",
    "quarantine",
    "parent digest",
    "snapshot identity",
    "report tampering",
    "missing gate",
    "unknown process",
    "recent failure",
    "retained lease",
  ] as const)("retains snapshots with %s", async (reason) => {
    const f = fixture("failed");
    if (reason === "active lock") mkdirSync(join(f.prDir, "active"));
    if (reason === "quarantine")
      quarantineLoopExecution(f.snapshotOrder, "Uncertain process ownership");
    if (reason === "parent digest") {
      const p = join(f.passDir, "attempt.json");
      json(p, { ...JSON.parse(readFileSync(p, "utf8")), workOrderSha256: digest("foreign") });
    }
    if (reason === "snapshot identity")
      json(join(f.passDir, "work-order.json"), { ...f.snapshotOrder, projectPath: f.root });
    if (reason === "report tampering")
      json(join(f.snapshot, "CODE_REVIEW.json"), { ...f.report, verdict: "findings" });
    if (reason === "missing gate") rmSync(join(f.runDir, "system-gate.json"));
    if (reason === "unknown process") rmSync(join(f.external, "process.json"));
    if (reason === "recent failure") {
      if (!f.order.executionIsolation) throw new Error("Missing fixture isolation");
      f.order.executionIsolation.cleanup.retainFailureForHours = 1;
      writeLoopSupervisorWorkOrderState({
        workOrder: f.order,
        supervisorSession: "supervisor",
        status: "failed",
        now: NOW,
      });
    }
    if (reason === "retained lease")
      writeLoopSupervisorWorkerLeaseState({
        leases: [
          {
            workOrderId: f.order.id,
            projectId: f.order.projectId,
            projectPath: f.order.projectPath,
            workerSession: "worker",
            status: "retained",
            leasedAt: NOW,
            updatedAt: NOW,
            retainUntil: NOW + 4000,
          },
        ],
      });
    await reconcileTerminalSupervisorResources({ now: NOW + 1000, runGit });
    expect(existsSync(f.snapshot)).toBe(true);
    expect(existsSync(join(f.passDir, "workspace-cleanup.json"))).toBe(false);
  });

  it("retains a snapshot open by a same-user process", async () => {
    const f = fixture();
    const fd = openSync(join(f.snapshot, "source.txt"), "r");
    try {
      await reconcileTerminalSupervisorResources({ now: NOW + 1000, runGit });
      expect(existsSync(f.snapshot)).toBe(true);
    } finally {
      closeSync(fd);
    }
    await reconcileTerminalSupervisorResources({ now: NOW + 1001, runGit });
    expect(existsSync(f.snapshot)).toBe(false);
  });

  it("retains an accepted snapshot whose source changed after review", async () => {
    const f = fixture();
    writeFileSync(join(f.snapshot, "source.txt"), "changed after acceptance\n");
    await reconcileTerminalSupervisorResources({ now: NOW + 1000, runGit });
    expect(existsSync(f.snapshot)).toBe(true);
  });

  it("retains snapshots when process inspection is unavailable", async () => {
    const f = fixture();
    const path = process.env.PATH;
    try {
      process.env.PATH = f.root;
      await reconcileTerminalSupervisorResources({ now: NOW + 1000, runGit });
      expect(existsSync(f.snapshot)).toBe(true);
    } finally {
      process.env.PATH = path;
    }
  });

  it("archives a stopped preparation with durable ownership before reviewer launch", async () => {
    const f = fixture("failed");
    rmSync(f.external, { recursive: true });
    rmSync(join(f.passDir, "accepted-review.json"));
    rmSync(join(f.snapshot, "CODE_REVIEW.json"));
    const snapshot = {
      ...f.snapshotOrder,
      task: { ...f.snapshotOrder.task, reviewContext: { headSha: f.head } },
    };
    json(join(f.passDir, "work-order.json"), snapshot);
    json(join(f.passDir, "preparation-finished.json"), {
      workOrderId: snapshot.id,
      workOrderSha256: digest(JSON.stringify(snapshot)),
      knownProcessesStopped: true,
    });
    await reconcileTerminalSupervisorResources({ now: NOW + 1000, runGit });
    expect(existsSync(f.snapshot)).toBe(false);
  });

  it.each(["declared-failure", "reconciled-stop"] as const)(
    "preserves raw failed source and partial report for %s",
    async (marker) => {
      const f = fixture("failed");
      rmSync(join(f.passDir, "accepted-review.json"));
      rmSync(join(f.external, "accepted-receipt.json"));
      const receiptPath = join(f.external, "receipt.json");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      receipt.result.status = "blocked";
      json(receiptPath, receipt);
      json(join(f.external, "process.json"), {
        status: 1,
        ...(marker === "reconciled-stop"
          ? { stopped: { reason: "timed_out", knownProcessesStopped: true } }
          : {}),
      });
      json(join(f.external, `${marker}.json`), {
        invocationId: receipt.invocationId,
        taskInputSha256: receipt.taskInputSha256,
        receiptSha256: digest(readFileSync(receiptPath)),
        receiptStatus: "blocked",
        archivePath: join(f.external, "ralph-state"),
      });
      writeFileSync(join(f.snapshot, "source.txt"), "failed review local bytes\n");
      writeFileSync(join(f.snapshot, "CODE_REVIEW.json"), '{"partial":');
      await reconcileTerminalSupervisorResources({ now: NOW + 1000, runGit });
      expect(existsSync(f.snapshot)).toBe(false);
      expect(readFileSync(join(f.passDir, "CODE_REVIEW.json"), "utf8")).toBe('{"partial":');
      const cleanup = JSON.parse(readFileSync(join(f.passDir, "workspace-cleanup.json"), "utf8"));
      const archive = JSON.parse(gunzipSync(readFileSync(cleanup.archivePath)).toString());
      const source = archive.files.find((file: { path: string }) => file.path === "source.txt");
      expect(Buffer.from(source.data, "base64").toString()).toBe("failed review local bytes\n");
    },
  );

  it("retains a live worker even after the parent execution checkout is gone", async () => {
    const f = fixture();
    f.order.workerSession = "worker";
    writeLoopSupervisorWorkOrderState({
      workOrder: f.order,
      supervisorSession: "supervisor",
      status: "completed",
      now: NOW,
    });
    await reconcileTerminalSupervisorResources({
      now: NOW + 1000,
      runGit,
      workerSessionExists: () => true,
      workerSessionOwnsActiveTurn: () => true,
    });
    expect(existsSync(f.snapshot)).toBe(true);
  });

  it("does not follow a snapshot symlink", async () => {
    const f = fixture();
    const target = join(f.root, "source-repository");
    renameSync(f.snapshot, target);
    symlinkSync(target, f.snapshot);
    await reconcileTerminalSupervisorResources({ now: NOW + 1000, runGit });
    expect(existsSync(join(target, "source.txt"))).toBe(true);
    expect(existsSync(join(f.passDir, "workspace-cleanup.json"))).toBe(false);
  });

  it("retains a snapshot when recovery fails and retries on the next reconciliation", async () => {
    const f = fixture();
    const failingGit = (invocation: LoopGitInvocation) =>
      invocation.args.includes("fsck")
        ? { status: 1, stdout: "", stderr: "fixture archive failure" }
        : runGit(invocation);
    await reconcileTerminalSupervisorResources({ now: NOW + 1000, runGit: failingGit });
    expect(existsSync(f.snapshot)).toBe(true);
    await reconcileTerminalSupervisorResources({ now: NOW + 1001, runGit });
    expect(existsSync(f.snapshot)).toBe(false);
  });
});
