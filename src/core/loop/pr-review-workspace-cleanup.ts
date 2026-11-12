import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";
import { createLogger } from "../../shared/utils/logger.js";
import { loopRunDir } from "./artifacts.js";
import { loopExecutionPathQuarantined } from "./execution-quarantine.js";
import { hasRalphPrReviewer, prReviewSourceFingerprint } from "./ralph-pr-review.js";
import type { LoopGitInvocation, LoopRunCommandResult } from "./run.js";
import type { UnfinishedLoopSupervisorWorkOrder } from "./supervisor-state.js";
import type { LoopWorkOrder } from "./work-order-contract.js";
import { archivePrReviewWorktree, safePrReviewWorktreePath } from "./worktree-recovery.js";

const log = createLogger("loop.pr-review-workspace-cleanup");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function bytes(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
    throw new Error("Unsafe PR review evidence file");
  return readFileSync(path);
}
function read(path: string): Record<string, any> {
  return JSON.parse(bytes(path).toString("utf8"));
}

export function hasPrReviewWorktrees(workOrder: LoopWorkOrder): boolean {
  if (!hasRalphPrReviewer(workOrder)) return false;
  const root = join(loopRunDir(workOrder.projectId, workOrder.id), "pr-reviews");
  try {
    return readdirSync(root, { withFileTypes: true }).some(
      (pr) =>
        pr.isDirectory() &&
        readdirSync(join(root, pr.name), { withFileTypes: true }).some(
          (pass) => pass.isDirectory() && existsSync(join(root, pr.name, pass.name, "worktree")),
        ),
    );
  } catch {
    return false;
  }
}

/** Absence must be observed, including escaped children holding an open file or cwd. */
function workspaceUnused(worktree: string): boolean {
  if (process.getuid === undefined) return false;
  const result = spawnSync(
    "lsof",
    ["-nP", "-a", "-u", String(process.getuid()), "+D", worktree, "-Fp"],
    {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    },
  );
  return (
    result.error === undefined &&
    result.signal === null &&
    result.status === 1 &&
    result.stdout.trim() === "" &&
    result.stderr.trim() === ""
  );
}

function protectedPath(path: string, paths: ReadonlySet<string>): boolean {
  return [...paths].some(
    (other) => path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`),
  );
}

function settledParent(record: UnfinishedLoopSupervisorWorkOrder, now: number): boolean {
  const { workOrder, runDir } = record;
  const state = read(join(runDir, "work-order-state.json"));
  const gate = read(join(runDir, "system-gate.json"));
  const retention = (workOrder.executionIsolation?.cleanup.retainFailureForHours ?? 72) * 3600000;
  return (
    resolve(runDir) === resolve(loopRunDir(workOrder.projectId, workOrder.id)) &&
    resolve(
      dirname(workOrder.finalSummaryPath ?? join(runDir, "supervisor-final-summary.json")),
    ) === resolve(runDir) &&
    hash(JSON.stringify(read(join(runDir, "work-order.json")))) ===
      hash(JSON.stringify(workOrder)) &&
    state.runId === workOrder.id &&
    state.projectId === workOrder.projectId &&
    state.scheduledAt === workOrder.scheduledAt &&
    ["completed", "failed", "cancelled"].includes(state.status) &&
    typeof state.updatedAt === "number" &&
    state.updatedAt + (state.status === "completed" ? 0 : retention) <= now &&
    gate.workOrderId === workOrder.id &&
    gate.projectId === workOrder.projectId
  );
}

function passEvidence(workOrder: LoopWorkOrder, passDir: string, worktree: string) {
  const evidence = new Map<string, string>();
  const capture = (path: string) => {
    const value = bytes(path);
    evidence.set(path, hash(value));
    return value;
  };
  const data = (name: string): Record<string, any> =>
    JSON.parse(capture(join(passDir, name)).toString("utf8"));
  const attempt = data("attempt.json");
  const snapshot = data("work-order.json") as LoopWorkOrder;
  const parentDigest = hash(JSON.stringify(workOrder));
  const snapshotDigest = hash(JSON.stringify(snapshot));
  if (
    attempt.workOrderSha256 !== parentDigest ||
    !Number.isSafeInteger(attempt.sequence) ||
    attempt.sequence < 1 ||
    String(attempt.number) !== dirname(passDir).split("/").at(-1) ||
    snapshot.projectId !== workOrder.projectId ||
    !snapshot.id.startsWith(`${workOrder.id}:pr:${attempt.number}:${attempt.sequence}:`) ||
    snapshot.projectPath !== worktree ||
    snapshot.finalSummaryPath !== join(passDir, "supervisor-final-summary.json") ||
    !hasRalphPrReviewer(snapshot) ||
    snapshot.workspace !== undefined ||
    (workOrder.task?.kind === "repository-pull-request-review" &&
      workOrder.task.repo !== attempt.repository)
  )
    throw new Error("PR snapshot ownership identity differs");
  let accepted: Record<string, any> | undefined;
  const external = join(passDir, "external-execution");
  if (!existsSync(external)) {
    const preparation = data("preparation-finished.json");
    const head =
      snapshot.task?.kind === "pull-request-review" ||
      snapshot.task?.kind === "repository-pull-request-review"
        ? snapshot.task.reviewContext?.headSha
        : undefined;
    if (
      preparation.workOrderId !== snapshot.id ||
      preparation.workOrderSha256 !== snapshotDigest ||
      preparation.knownProcessesStopped !== true ||
      head === undefined
    )
      throw new Error("PR snapshot preparation shutdown is unproven");
    return { evidence, snapshot, head, parentDigest, accepted, attempt };
  }
  const reservation = data("external-execution/reservation.json");
  const receipt = data("external-execution/receipt.json");
  const processResult = data("external-execution/process.json");
  const taskHash = hash(capture(join(external, "task.md")));
  if (
    reservation.workOrderId !== snapshot.id ||
    reservation.workOrderSha256 !== snapshotDigest ||
    reservation.workspace !== worktree ||
    receipt.workspace?.path !== worktree ||
    receipt.workspace?.head !== reservation.baseHead ||
    receipt.workspace?.baseHead !== reservation.baseHead ||
    reservation.invocationId !== receipt.invocationId ||
    reservation.taskInputSha256 !== taskHash ||
    receipt.taskInputSha256 !== taskHash ||
    !Number.isInteger(processResult.status) ||
    (processResult.stopped !== undefined && processResult.stopped.knownProcessesStopped !== true)
  )
    throw new Error("PR snapshot process evidence differs");
  const markerName = [
    "accepted-receipt.json",
    "declared-failure.json",
    "reconciled-stop.json",
  ].find((name) => existsSync(join(external, name)));
  if (markerName === undefined) throw new Error("PR snapshot has no proven terminal execution");
  const marker = data(`external-execution/${markerName}`);
  const legacyStatePath = join(worktree, ".ralph");
  const legacyState = lstatSync(legacyStatePath, { throwIfNoEntry: false });
  const unusedLegacyState =
    legacyState === undefined ||
    (legacyState.isDirectory() &&
      !legacyState.isSymbolicLink() &&
      readdirSync(legacyStatePath).length === 0);
  if (
    marker.archivePath !== join(external, "ralph-state") ||
    !lstatSync(marker.archivePath).isDirectory() ||
    lstatSync(marker.archivePath).isSymbolicLink() ||
    existsSync(join(external, "ralph-active-state")) ||
    !unusedLegacyState ||
    (markerName === "declared-failure.json"
      ? marker.receiptStatus !== receipt.result?.status
      : marker.invocationId !== receipt.invocationId ||
        marker.taskInputSha256 !== taskHash ||
        marker.receiptSha256 !== evidence.get(join(external, "receipt.json")))
  )
    throw new Error("PR snapshot shutdown proof differs");
  if (existsSync(join(passDir, "accepted-review.json"))) {
    accepted = data("accepted-review.json");
    if (
      accepted.workOrderSha256 !== parentDigest ||
      accepted.sequence !== attempt.sequence ||
      accepted.number !== attempt.number ||
      accepted.repository !== attempt.repository ||
      hash(JSON.stringify(accepted.snapshotOrder)) !== snapshotDigest ||
      accepted.revision?.headSha !== receipt.workspace.head ||
      accepted.sourceSha256 !== prReviewSourceFingerprint(worktree) ||
      !isDeepStrictEqual(
        JSON.parse(capture(join(worktree, "CODE_REVIEW.json")).toString("utf8")),
        accepted.report,
      )
    )
      throw new Error("PR accepted review evidence differs");
  }
  return { evidence, snapshot, head: reservation.baseHead, parentDigest, accepted, attempt };
}

/** Release only settled, unowned review leaves; pass artifacts remain outside the removed snapshot. */
export function cleanupTerminalPrReviewWorktrees(input: {
  record: UnfinishedLoopSupervisorWorkOrder;
  now: number;
  protectedPaths: ReadonlySet<string>;
  maxCleanups: number;
  runGit: (invocation: LoopGitInvocation) => LoopRunCommandResult;
}): number {
  const { record, runGit } = input;
  const { workOrder, runDir } = record;
  if (!hasPrReviewWorktrees(workOrder) || input.maxCleanups <= 0) return 0;
  const quarantined = (worktree: string) =>
    [
      worktree,
      workOrder.projectPath,
      ...(workOrder.executionIsolation?.sourceWorktree === undefined
        ? []
        : [workOrder.executionIsolation.sourceWorktree]),
    ].some(loopExecutionPathQuarantined);
  let removed = 0;
  try {
    if (
      !settledParent(record, input.now) ||
      protectedPath(resolve(workOrder.projectPath), input.protectedPaths) ||
      quarantined(workOrder.projectPath)
    )
      return 0;
    const root = join(runDir, "pr-reviews");
    for (const pr of readdirSync(root, { withFileTypes: true })) {
      if (!pr.isDirectory() || !/^[1-9]\d*$/.test(pr.name)) continue;
      const prDir = join(root, pr.name);
      const lock = join(prDir, "active");
      const entries = readdirSync(prDir, { withFileTypes: true });
      const safePass = entries.find(
        (entry) =>
          entry.isDirectory() &&
          safePrReviewWorktreePath(join(prDir, entry.name, "worktree"), runDir),
      );
      if (safePass === undefined || existsSync(lock)) continue;
      try {
        mkdirSync(lock);
      } catch {
        continue;
      }
      try {
        for (const pass of entries) {
          if (!pass.isDirectory()) continue;
          const passDir = join(prDir, pass.name);
          const worktree = join(passDir, "worktree");
          if (!existsSync(worktree) || !safePrReviewWorktreePath(worktree, runDir)) continue;
          try {
            if (
              !settledParent(record, input.now) ||
              protectedPath(resolve(worktree), input.protectedPaths) ||
              quarantined(worktree) ||
              !workspaceUnused(worktree)
            )
              continue;
            const passData = passEvidence(workOrder, passDir, worktree);
            const top = runGit({ cwd: worktree, args: ["rev-parse", "--show-toplevel"] });
            const branch = runGit({ cwd: worktree, args: ["branch", "--show-current"] });
            const head = runGit({ cwd: worktree, args: ["rev-parse", "HEAD"] });
            if (
              top.status !== 0 ||
              resolve(top.stdout.trim()) !== resolve(worktree) ||
              branch.status !== 0 ||
              branch.stdout.trim() !== "" ||
              head.status !== 0 ||
              head.stdout.trim() !== passData.head
            )
              continue;
            const archive = archivePrReviewWorktree({
              worktree,
              runDir,
              workOrderId: passData.snapshot.id,
              runGit,
            });
            if (archive === null) continue;
            const reportPath = join(worktree, "CODE_REVIEW.json");
            let reportSha256: string | undefined;
            if (existsSync(reportPath)) {
              const report = bytes(reportPath);
              const retainedReport = join(passDir, "CODE_REVIEW.json");
              if (!existsSync(retainedReport))
                writeFileSync(retainedReport, report, { flag: "wx", mode: 0o600 });
              if (!bytes(retainedReport).equals(report))
                throw new Error("Archived PR report differs");
              reportSha256 = hash(report);
            }
            if (
              !settledParent(record, input.now) ||
              quarantined(worktree) ||
              !workspaceUnused(worktree) ||
              [...passData.evidence].some(([path, expected]) => hash(bytes(path)) !== expected) ||
              (passData.accepted !== undefined &&
                passData.accepted.sourceSha256 !== prReviewSourceFingerprint(worktree)) ||
              !archive.verify()
            )
              continue;
            writeFileAtomicSync(
              join(passDir, "workspace-cleanup.json"),
              JSON.stringify({
                schemaVersion: 1,
                workOrderId: workOrder.id,
                workOrderSha256: passData.parentDigest,
                snapshotWorkOrderId: passData.snapshot.id,
                worktree,
                archivePath: archive.path,
                head: passData.head,
                reportSha256,
                sourceSha256: passData.accepted?.sourceSha256,
                revision: passData.accepted?.revision,
                evidenceSha256: Object.fromEntries(passData.evidence),
              }),
            );
            if (!archive.verify() || !safePrReviewWorktreePath(worktree, runDir)) continue;
            rmSync(worktree, { recursive: true });
            removed++;
            if (removed >= input.maxCleanups) return removed;
          } catch (err) {
            log.warn("loop retained PR review snapshot because cleanup could not be verified", {
              err,
              data: { worktree },
            });
          }
        }
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    }
  } catch (err) {
    log.warn("loop retained PR review snapshots because terminal ownership could not be verified", {
      err,
      data: { workOrderId: workOrder.id },
    });
  }
  return removed;
}
