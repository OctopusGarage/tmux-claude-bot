import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { loopRunArtifactPath } from "./artifacts.js";
import { quarantineLoopExecution } from "./execution-quarantine.js";
import { githubCommandForAccount } from "./github-auth.js";
import { RalphProcessOwnershipError, runRalphProcess } from "./ralph-process.js";
import { executeRalphTask, readRalphTaskEvidence } from "./ralph-task.js";
import type { LoopRunCommandInvocation, LoopRunCommandResult } from "./run.js";
import type { LoopSupervisorPullRequestDecision, LoopWorkOrder } from "./work-order-contract.js";

const sha = z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/);
const hash = z.string().regex(/^[a-fA-F0-9]{64}$/);
const boundedText = (max = 16384) =>
  z.string().refine((value) => value.trim().length > 0 && [...value].length <= max);
const text = boundedText();
const revisionSchema = z.object({ baseSha: sha, headSha: sha, diffSha256: hash }).strict();
const reviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: revisionSchema,
    verdict: z.enum(["clean", "findings", "incomplete"]),
    reviewedScope: text,
    findings: z
      .array(
        z
          .object({
            severity: z.enum(["P0", "P1", "P2", "P3"]),
            path: z
              .string()
              .refine(
                (value) =>
                  value.trim().length > 0 &&
                  [...value].length <= 4096 &&
                  ![...value].some(
                    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
                  ),
              )
              .refine(
                (value) =>
                  !value.startsWith("/") &&
                  !value.includes("\\") &&
                  !/^[A-Za-z]:/.test(value) &&
                  !value.split("/").some((part) => part === ".." || part === "" || part === "."),
              ),
            line: z.number().int().positive(),
            title: boundedText(512),
            trigger: text,
            consequence: text,
            remedy: text,
            evidence: z.array(text).min(1).max(100),
          })
          .strict(),
      )
      .max(500),
    limitations: z.array(text).max(100),
  })
  .strict();

export function parseRalphCodeReview(value: unknown, revision: z.infer<typeof revisionSchema>) {
  const report = reviewSchema.parse(value);
  if (
    !isDeepStrictEqual(report.revision, revision) ||
    (report.verdict === "clean" && report.findings.length !== 0) ||
    (report.verdict === "findings" && report.findings.length === 0)
  )
    throw new Error("RalphWorks review verdict or revision mismatch");
  return report;
}

export function hasRalphPrReviewer(workOrder: LoopWorkOrder): boolean {
  const task = workOrder.task;
  return (
    (task?.kind === "pull-request-review" || task?.kind === "repository-pull-request-review") &&
    task.reviewer?.kind === "ralphworks"
  );
}

const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
function readJson(path: string, maxBytes = 4 * 1024 * 1024): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
    throw new Error("Invalid review evidence file");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)));
}
function artifactDir(workOrder: LoopWorkOrder): string {
  return dirname(
    workOrder.finalSummaryPath ??
      loopRunArtifactPath(workOrder.projectId, workOrder.id, "supervisorFinalSummary"),
  );
}
function deadlinePath(workOrder: LoopWorkOrder): string {
  return join(artifactDir(workOrder), "pr-review-deadline.json");
}

/** Pin one deadline for all review passes, retries and repairs of this WorkOrder. */
export function reserveRalphPrReviewDeadline(
  workOrder: LoopWorkOrder,
  timeoutMs: number,
  deadline = Date.now() + timeoutMs,
): void {
  if (!hasRalphPrReviewer(workOrder)) return;
  const path = deadlinePath(workOrder);
  const expiresAt = Math.min(deadline, Date.now() + timeoutMs);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const prior = readDeadline(workOrder);
    if (prior.expiresAt <= Date.now()) throw new Error("RalphWorks PR review deadline exhausted");
    return;
  }
  writeFileSync(
    path,
    JSON.stringify({ workOrderSha256: digest(JSON.stringify(workOrder)), expiresAt }),
    { flag: "wx" },
  );
}
export function ralphPrReviewDeadline(workOrder: LoopWorkOrder): number {
  return readDeadline(workOrder).expiresAt;
}
function readDeadline(workOrder: LoopWorkOrder) {
  const value = z
    .object({ workOrderSha256: hash, expiresAt: z.number().finite() })
    .strict()
    .parse(readJson(deadlinePath(workOrder)));
  if (value.workOrderSha256 !== digest(JSON.stringify(workOrder)))
    throw new Error("RalphWorks review WorkOrder changed");
  return value;
}

export function readPrReviewWorkOrder(path: string): LoopWorkOrder {
  const value = readJson(path);
  z.object({
    id: text,
    projectId: text,
    projectPath: text,
    scheduledAt: z.number(),
    finalSummaryPath: text.optional(),
    task: z
      .object({
        kind: z.enum(["pull-request-review", "repository-pull-request-review"]),
        consecutivePasses: z.number().int().positive(),
      })
      .passthrough(),
  })
    .passthrough()
    .parse(value);
  const workOrder = value as LoopWorkOrder;
  if (
    !hasRalphPrReviewer(workOrder) ||
    workOrder.workspace !== undefined ||
    realpathSync(path) !== realpathSync(join(artifactDir(workOrder), "work-order.json"))
  )
    throw new Error("Invalid external PR review WorkOrder location or selection");
  readDeadline(workOrder);
  return workOrder;
}

export function prReviewSourceFingerprint(root: string): string {
  const hash = createHash("sha256");
  let bytes = 0;
  let files = 0;
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (prefix === "" && [".git", ".ralph", "CODE_REVIEW.json"].includes(name)) continue;
      const path = join(directory, name),
        relative = prefix + name,
        stat = lstatSync(path);
      files++;
      bytes += stat.size;
      if (files > 100000 || bytes > 512 * 1024 * 1024)
        throw new Error("PR snapshot exceeds bounded source inventory");
      if (stat.isSymbolicLink())
        hash.update(JSON.stringify([relative, stat.mode, "symlink", readlinkSync(path)]));
      else if (stat.isDirectory()) {
        hash.update(JSON.stringify([relative, stat.mode, "directory"]));
        visit(path, `${relative}/`);
      } else if (stat.isFile())
        hash.update(JSON.stringify([relative, stat.mode, "file", digest(readFileSync(path))]));
      else throw new Error("Unsupported PR snapshot entry");
    }
  };
  visit(root, "");
  return hash.digest("hex");
}

/** One immutable candidate/revision per CLI invocation; GitHub lifecycle remains caller-owned. */
export async function runRalphPrReviewPass(
  input: {
    workOrder: LoopWorkOrder;
    number: number;
    repository: string;
    baseSha: string;
    headSha: string;
    timeoutMs: number;
    signal: AbortSignal;
  },
  executable = "ralph",
) {
  const { workOrder } = input;
  if (
    !hasRalphPrReviewer(workOrder) ||
    workOrder.workspace !== undefined ||
    !workOrder.execution.agent ||
    workOrder.runner.kind !== "agent-supervised"
  )
    throw new Error("RalphWorks PR review requires a supervised single repository");
  z.number().int().positive().parse(input.number);
  z.number().finite().positive().parse(input.timeoutMs);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
    throw new Error("Invalid PR repository");
  if (
    workOrder.task?.kind === "repository-pull-request-review" &&
    workOrder.task.repo !== input.repository
  )
    throw new Error("PR repository differs from WorkOrder");
  sha.parse(input.baseSha);
  sha.parse(input.headSha);
  const deadline = Math.min(readDeadline(workOrder).expiresAt, Date.now() + input.timeoutMs);
  const source = realpathSync(workOrder.projectPath);
  let pendingSnapshot: LoopWorkOrder | undefined;
  let preparationKnownStopped = true;
  let externalStarted = false;
  const run = async (command: string, args: string[], cwd = source) => {
    if (Date.now() >= deadline) throw new Error("RalphWorks PR review deadline exhausted");
    let observed: Parameters<typeof quarantineLoopExecution>[2] = [];
    const result = await runRalphProcess({
      executable: command,
      args,
      cwd,
      timeoutMs: deadline - Date.now(),
      signal: input.signal,
      onOwnedProcesses: (processes) => {
        observed = processes;
      },
    }).catch((error: unknown) => {
      preparationKnownStopped = false;
      if (pendingSnapshot !== undefined)
        quarantineLoopExecution(
          pendingSnapshot,
          "PR snapshot preparation process ownership is uncertain",
          observed,
        );
      throw error;
    });
    if (result.status !== 0 || result.stopped !== undefined)
      throw new Error("PR snapshot command failed or stopped");
    return result.stdout;
  };
  const root = join(artifactDir(workOrder), "pr-reviews", String(input.number));
  mkdirSync(root, { recursive: true });
  const lock = join(root, "active");
  mkdirSync(lock);
  try {
    const statePath = join(artifactDir(workOrder), "work-order-state.json");
    if (existsSync(statePath)) {
      const state = z.object({ status: z.string() }).parse(readJson(statePath));
      if (["completed", "failed", "cancelled"].includes(state.status))
        throw new Error("PR review parent is terminal");
    }
    const passDir = join(root, randomUUID());
    mkdirSync(passDir);
    const sequence =
      readdirSync(root).filter((name) => existsSync(join(root, name, "attempt.json"))).length + 1;
    writeFileSync(
      join(passDir, "attempt.json"),
      JSON.stringify({
        workOrderSha256: digest(JSON.stringify(workOrder)),
        sequence,
        number: input.number,
        repository: input.repository,
      }),
      { flag: "wx" },
    );
    if (realpathSync((await run("git", ["rev-parse", "--show-toplevel"])).trim()) !== source)
      throw new Error("PR repository root mismatch");
    if (workOrder.task?.kind === "pull-request-review") {
      const remote = (await run("git", ["remote", "get-url", "origin"])).trim();
      if (
        !remote.replace(/\.git$/, "").endsWith(`/${input.repository}`) &&
        !remote.replace(/\.git$/, "").endsWith(`:${input.repository}`)
      )
        throw new Error("PR repository differs from configured origin");
    }
    const diff = await run("git", [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--binary",
      `${input.baseSha}...${input.headSha}`,
      "--",
    ]);
    if (Buffer.byteLength(diff) > 512 * 1024)
      throw new Error("PR diff exceeds bounded review input; split or use native explicitly");
    const snapshot = join(passDir, "worktree");
    const revision = { baseSha: input.baseSha, headSha: input.headSha, diffSha256: digest(diff) };
    const context = {
      ...revision,
      diff,
      repository: input.repository,
      number: input.number,
      pass: sequence,
    };
    const snapshotTask = structuredClone(workOrder.task);
    if (
      snapshotTask?.kind !== "pull-request-review" &&
      snapshotTask?.kind !== "repository-pull-request-review"
    )
      throw new Error("Invalid review task");
    snapshotTask.reviewContext = context;
    const check = `${quote(executable)} review validate CODE_REVIEW.json --base-sha ${revision.baseSha} --head-sha ${revision.headSha} --diff-sha256 ${revision.diffSha256}`;
    const snapshotOrder: LoopWorkOrder = {
      ...structuredClone(workOrder),
      id: `${workOrder.id}:pr:${input.number}:${sequence}:${randomUUID()}`,
      task: snapshotTask,
      projectPath: snapshot,
      finalSummaryPath: join(passDir, "supervisor-final-summary.json"),
      preflight: { commands: [], repair: { agent: false } },
      assessment: { command: check },
      eval: undefined,
      maxRounds: 2,
      commitPolicy: { enabled: false, perRound: false },
    };
    delete snapshotOrder.executionIsolation;
    writeFileSync(join(passDir, "work-order.json"), JSON.stringify(snapshotOrder), { flag: "wx" });
    pendingSnapshot = snapshotOrder;
    await run("git", ["clone", "--no-hardlinks", "--no-checkout", "--", source, snapshot]);
    await run("git", ["checkout", "--detach", input.headSha], snapshot);
    try {
      lstatSync(join(snapshot, "CODE_REVIEW.json"));
      throw new Error(
        "Reserved CODE_REVIEW.json already exists in candidate; review requires a fresh output path",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await run("git", ["remote", "remove", "origin"], snapshot);
    const sourceSha256 = prReviewSourceFingerprint(snapshot);
    const evidence = await executeRalphTask(
      {
        workOrder: snapshotOrder,
        timeoutMs: deadline - Date.now(),
        signal: input.signal,
        onStarted: () => {
          externalStarted = true;
        },
      },
      executable,
    ).catch((error: unknown) => {
      if (!externalStarted && error instanceof RalphProcessOwnershipError) {
        preparationKnownStopped = false;
        quarantineLoopExecution(
          snapshotOrder,
          "PR snapshot task precheck process ownership is uncertain",
        );
      }
      throw error;
    });
    const report = parseRalphCodeReview(
      readJson(join(snapshot, "CODE_REVIEW.json"), 1024 * 1024),
      revision,
    );
    if (prReviewSourceFingerprint(snapshot) !== sourceSha256)
      throw new Error("External review modified source or wrote unauthorized files");
    readRalphTaskEvidence(snapshotOrder);
    const accepted = {
      schemaVersion: 1,
      workOrderSha256: digest(JSON.stringify(workOrder)),
      sequence,
      repository: input.repository,
      number: input.number,
      revision,
      report,
      evidence,
      snapshotOrder,
      sourceSha256,
    };
    writeFileSync(join(passDir, "accepted-review.json"), JSON.stringify(accepted), { flag: "wx" });
    return {
      verdict: report.verdict,
      findings: report.findings,
      limitations: report.limitations,
      revision,
      pass: sequence,
      evidencePath: join(passDir, "accepted-review.json"),
    };
  } finally {
    try {
      if (pendingSnapshot !== undefined && !externalStarted && preparationKnownStopped)
        writeFileSync(
          join(dirname(pendingSnapshot.finalSummaryPath as string), "preparation-finished.json"),
          JSON.stringify({
            workOrderId: pendingSnapshot.id,
            workOrderSha256: digest(JSON.stringify(pendingSnapshot)),
            knownProcessesStopped: true,
          }),
          { flag: "wx" },
        );
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

/** Independently check clean consecutive passes; failed/incomplete or changed revisions reset the count. */
export function assertRalphPrReviewPasses(
  workOrder: LoopWorkOrder,
  decision: LoopSupervisorPullRequestDecision,
  current: { baseSha?: string; headSha: string },
): void {
  if (!hasRalphPrReviewer(workOrder)) return;
  if (decision.reviewedHeadSha !== current.headSha)
    throw new Error("PR advanced after external review");
  const root = join(artifactDir(workOrder), "pr-reviews", String(decision.number));
  if (existsSync(join(root, "active"))) throw new Error("External review pass is still active");
  const invocationIds = new Set<string>();
  const passes = readdirSync(root)
    .filter((name) => existsSync(join(root, name, "attempt.json")))
    .map((name) => {
      const attempt = z
        .object({
          workOrderSha256: hash,
          sequence: z.number().int().positive(),
          number: z.number(),
          repository: text,
        })
        .strict()
        .parse(readJson(join(root, name, "attempt.json")));
      if (
        attempt.workOrderSha256 !== digest(JSON.stringify(workOrder)) ||
        attempt.repository !== decision.repository ||
        attempt.number !== decision.number
      )
        throw new Error("PR attempt identity mismatch");
      if (!existsSync(join(root, name, "accepted-review.json")))
        return { sequence: attempt.sequence, revision: undefined, report: undefined };
      const accepted = z
        .object({
          schemaVersion: z.literal(1),
          workOrderSha256: hash,
          sequence: z.number().int().positive(),
          repository: text,
          number: z.number().int().positive(),
          revision: revisionSchema,
          report: z.unknown(),
          snapshotOrder: z.unknown(),
          sourceSha256: hash,
        })
        .passthrough()
        .parse(readJson(join(root, name, "accepted-review.json")));
      if (
        accepted.workOrderSha256 !== digest(JSON.stringify(workOrder)) ||
        accepted.repository !== decision.repository ||
        accepted.number !== decision.number ||
        accepted.sequence !== attempt.sequence
      )
        throw new Error("PR evidence belongs to a different WorkOrder or candidate");
      const snapshot = accepted.snapshotOrder as LoopWorkOrder;
      const evidence = readRalphTaskEvidence(snapshot);
      const context =
        snapshot.task?.kind === "pull-request-review" ||
        snapshot.task?.kind === "repository-pull-request-review"
          ? snapshot.task.reviewContext
          : undefined;
      if (
        invocationIds.has(evidence.invocationId) ||
        context?.pass !== accepted.sequence ||
        !isDeepStrictEqual(
          { baseSha: context.baseSha, headSha: context.headSha, diffSha256: context.diffSha256 },
          accepted.revision,
        ) ||
        resolve(snapshot.projectPath) !== resolve(join(root, name, "worktree")) ||
        resolve(snapshot.finalSummaryPath ?? "") !==
          resolve(join(root, name, "supervisor-final-summary.json"))
      )
        throw new Error("Duplicate or mismatched independent PR review invocation");
      invocationIds.add(evidence.invocationId);
      if (
        prReviewSourceFingerprint(snapshot.projectPath) !== accepted.sourceSha256 ||
        execFileSync("git", ["-C", snapshot.projectPath, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim() !== accepted.revision.headSha
      )
        throw new Error("PR snapshot source changed after review");
      const report = parseRalphCodeReview(
        readJson(join(snapshot.projectPath, "CODE_REVIEW.json"), 1024 * 1024),
        accepted.revision,
      );
      if (!isDeepStrictEqual(report, accepted.report)) throw new Error("PR review report changed");
      return { sequence: accepted.sequence, revision: accepted.revision, report };
    })
    .sort((a, b) => a.sequence - b.sequence);
  const task = workOrder.task;
  if (task?.kind !== "pull-request-review" && task?.kind !== "repository-pull-request-review")
    throw new Error("Invalid review task");
  let consecutive = 0;
  let revisionKey: string | undefined;
  for (let index = 0; index < passes.length; index++) {
    const pass = passes[index];
    if (pass === undefined || pass.sequence !== index + 1)
      throw new Error("Invalid review sequence");
    if (
      pass.revision === undefined ||
      pass.report === undefined ||
      pass.revision.headSha !== current.headSha ||
      (current.baseSha !== undefined && pass.revision.baseSha !== current.baseSha) ||
      pass.report.verdict !== "clean"
    ) {
      consecutive = 0;
      revisionKey = undefined;
      continue;
    }
    const currentKey = JSON.stringify(pass.revision);
    if (revisionKey !== undefined && revisionKey !== currentKey) consecutive = 0;
    revisionKey = currentKey;
    consecutive++;
  }
  if (consecutive < task.consecutivePasses)
    throw new Error("Missing consecutive clean external PR reviews for current revision");
}

/** Re-read GitHub state through the caller's account-pinned command boundary. */
export function validateRalphPrReviewGate(
  workOrder: LoopWorkOrder,
  decisions: LoopSupervisorPullRequestDecision[] | undefined,
  runCommand: (input: LoopRunCommandInvocation) => LoopRunCommandResult,
): void {
  if (!hasRalphPrReviewer(workOrder)) return;
  if (ralphPrReviewDeadline(workOrder) <= Date.now())
    throw new Error("External PR review deadline exhausted");
  if (decisions === undefined)
    throw new Error("External PR review requires explicit candidate decisions");
  const task = workOrder.task;
  const run = (args: string): unknown => {
    const command = githubCommandForAccount(workOrder.pullRequestPolicy?.githubAccount, args);
    const result = runCommand({
      kind: "pr",
      command,
      cwd: workOrder.projectPath,
      env: {},
      timeoutMs: Math.max(1, ralphPrReviewDeadline(workOrder) - Date.now()),
    });
    if (result.status !== 0) throw new Error("Cannot verify current PR revision");
    return JSON.parse(result.stdout);
  };
  const repo =
    task?.kind === "repository-pull-request-review"
      ? task.repo
      : z.object({ nameWithOwner: text }).parse(run("repo view --json nameWithOwner"))
          .nameWithOwner;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Invalid PR repository");
  const open = z
    .array(
      z.object({
        number: z.number().int().positive(),
        headRefName: z.string(),
        title: z.string(),
        body: z.string(),
        baseRefName: z.string(),
      }),
    )
    .parse(
      run(
        `pr list --repo ${quote(repo)} --state open --limit 1000 --json number,headRefName,title,body,baseRefName`,
      ),
    );
  if (open.length >= 1000) throw new Error("PR discovery reached its bounded listing limit");
  const scoped = open.filter((pr) =>
    task?.kind === "repository-pull-request-review"
      ? task.base === undefined || pr.baseRefName === task.base
      : pr.baseRefName === workOrder.pullRequestPolicy?.base &&
        (pr.headRefName.startsWith("loop/") || /Loop Engineering/i.test(`${pr.title}\n${pr.body}`)),
  );
  if (scoped.some((pr) => !decisions.some((d) => d.number === pr.number && d.repository === repo)))
    throw new Error("External PR review omitted an in-scope candidate");
  for (const decision of decisions) {
    if (decision.repository !== repo) throw new Error("PR decision repository mismatch");
    if (decision.outcome !== "approved" && decision.outcome !== "merged") continue;
    const current = z
      .object({ headRefOid: sha, baseRefOid: sha, state: z.enum(["OPEN", "CLOSED", "MERGED"]) })
      .parse(
        run(`pr view ${decision.number} --repo ${quote(repo)} --json headRefOid,baseRefOid,state`),
      );
    if (
      (decision.outcome === "merged" && current.state !== "MERGED") ||
      (decision.outcome === "approved" && current.state === "CLOSED")
    )
      throw new Error("PR delivery state differs from review decision");
    assertRalphPrReviewPasses(workOrder, decision, {
      headSha: current.headRefOid,
      ...(current.state === "MERGED" ? {} : { baseSha: current.baseRefOid }),
    });
  }
  if (ralphPrReviewDeadline(workOrder) <= Date.now())
    throw new Error("External PR review deadline exhausted");
}
