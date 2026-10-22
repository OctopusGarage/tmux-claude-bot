import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";
import { LOOP_RUN_ARTIFACTS } from "./artifacts.js";
import {
  buildIterationCheckpointTemplate,
  iterationCheckpointPath,
  readIterationCheckpoint,
} from "./iteration-checkpoint.js";
import type { LoopGitInvocation, LoopRunCommandResult } from "./run.js";
import type { LoopWorkOrder } from "./work-order-contract.js";

export type CheckpointSystemVerification = {
  schemaVersion: 1;
  source: "system-command";
  workOrderId: string;
  contractHash: string;
  revision: string;
  commandHash: string;
  exitStatus: number;
  passed: boolean;
  failures: string[];
  score: number | null;
  startedAt: string;
  endedAt: string;
  outputHash: string;
};

const SHA256_HEX = /^[a-f0-9]{64}$/;

/** Checks repository facts, not the truth of agent-reported behavioral tests. */
export function checkpointAcceptanceGate(
  workOrder: LoopWorkOrder,
  runGit: ((invocation: LoopGitInvocation) => LoopRunCommandResult) | undefined,
  systemVerifications: readonly CheckpointSystemVerification[] = [],
): { failures: string[]; evidence: string[] } {
  const checkpoint = readIterationCheckpoint(workOrder);
  const reject = (reason: string) => ({ failures: [reason], evidence: [] });
  const path = iterationCheckpointPath(workOrder);
  if (path === null) return { failures: [], evidence: [] };
  const marker = join(dirname(path), LOOP_RUN_ARTIFACTS.checkpointRequired);
  const contractHash = buildIterationCheckpointTemplate(workOrder).contractHash;
  const requirement = JSON.stringify({ schemaVersion: 1, contractHash });
  let required = false;
  try {
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.size > 1024 || readFileSync(marker, "utf8") !== requirement) {
      return reject("checkpoint requirement state invalid");
    }
    required = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      return reject("checkpoint requirement state unreadable");
    }
  }
  if (checkpoint.status === "absent") {
    return required
      ? reject("checkpoint required artifact is missing")
      : { failures: [], evidence: [] };
  }
  if (!required) {
    try {
      writeFileAtomicSync(marker, requirement);
    } catch {
      return reject("checkpoint requirement state cannot be persisted");
    }
  }
  if (checkpoint.status === "invalid") return reject(`checkpoint invalid: ${checkpoint.reason}`);
  const pending = checkpoint.checkpoint.items.filter((item) => item.status !== "reported-passed");
  if (pending.length > 0) {
    return reject(
      `checkpoint required acceptance items remain incomplete: ${pending.map((item) => item.id).join(", ")}`,
    );
  }
  if (runGit === undefined) return reject("checkpoint repository adapter unavailable");
  const query = (args: string[]) => runGit({ cwd: workOrder.projectPath, args });
  const root = query(["rev-parse", "--show-toplevel"]);
  if (root.status !== 0 || resolve(root.stdout.trim()) !== resolve(workOrder.projectPath)) {
    return reject("checkpoint repository toplevel mismatch or unavailable");
  }
  const head = query(["rev-parse", "HEAD"]);
  if (head.status !== 0) return reject("checkpoint repository HEAD unavailable");
  if (head.stdout.trim() !== checkpoint.checkpoint.repositoryRevision) {
    return reject("checkpoint revision is stale; revalidate required acceptance items");
  }
  const status = query(["status", "--porcelain"]);
  if (status.status !== 0) return reject("checkpoint repository status unavailable");
  if (status.stdout.trim() !== "")
    return reject("checkpoint worktree is dirty; acceptance deferred");
  const revision = head.stdout.trim();
  const verifications = [...systemVerifications, ...readDurableSystemVerifications(dirname(path))];
  const verificationCommand = workOrder.eval?.command ?? workOrder.assessment.command;
  const commandHash =
    verificationCommand === undefined
      ? null
      : createHash("sha256").update(verificationCommand).digest("hex");
  if (
    !verifications.some(
      (verification) =>
        verification.source === "system-command" &&
        verification.workOrderId === workOrder.id &&
        verification.contractHash === contractHash &&
        verification.revision === revision &&
        verification.commandHash === commandHash &&
        verification.passed === true,
    )
  ) {
    return reject(
      "checkpoint system verification artifact is missing or not passed for current revision",
    );
  }
  return {
    failures: [],
    evidence: [
      `checkpoint repository identity, HEAD and clean state verified at ${revision}`,
      "checkpoint behavioral verification matched a passed system command artifact",
    ],
  };
}

function readDurableSystemVerifications(runDir: string): CheckpointSystemVerification[] {
  const dir = join(runDir, LOOP_RUN_ARTIFACTS.commandVerifications);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    return [];
  }
  const records: CheckpointSystemVerification[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 65_536) continue;
      const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CheckpointSystemVerification>;
      if (
        value.schemaVersion === 1 &&
        value.source === "system-command" &&
        typeof value.workOrderId === "string" &&
        typeof value.contractHash === "string" &&
        typeof value.revision === "string" &&
        typeof value.commandHash === "string" &&
        SHA256_HEX.test(value.commandHash) &&
        typeof value.exitStatus === "number" &&
        Number.isInteger(value.exitStatus) &&
        value.exitStatus >= 0 &&
        typeof value.passed === "boolean" &&
        Array.isArray(value.failures) &&
        value.failures.every((failure) => typeof failure === "string") &&
        (value.score === null ||
          (typeof value.score === "number" && Number.isFinite(value.score))) &&
        typeof value.startedAt === "string" &&
        Number.isFinite(Date.parse(value.startedAt)) &&
        typeof value.endedAt === "string" &&
        Number.isFinite(Date.parse(value.endedAt)) &&
        typeof value.outputHash === "string" &&
        SHA256_HEX.test(value.outputHash) &&
        (!value.passed || (value.exitStatus === 0 && value.failures.length === 0))
      ) {
        records.push({
          schemaVersion: 1,
          source: "system-command",
          workOrderId: value.workOrderId,
          contractHash: value.contractHash,
          revision: value.revision,
          commandHash: value.commandHash,
          exitStatus: value.exitStatus,
          passed: value.passed,
          failures: value.failures,
          score: value.score,
          startedAt: value.startedAt,
          endedAt: value.endedAt,
          outputHash: value.outputHash,
        });
      }
    } catch {
      /* Ignore malformed historical verification artifacts; absence still fails closed. */
    }
  }
  return records;
}
