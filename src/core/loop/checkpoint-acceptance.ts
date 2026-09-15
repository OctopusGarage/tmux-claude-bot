import { lstatSync, readFileSync } from "node:fs";
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

/** Checks repository facts, not the truth of agent-reported behavioral tests. */
export function checkpointAcceptanceGate(
  workOrder: LoopWorkOrder,
  runGit: ((invocation: LoopGitInvocation) => LoopRunCommandResult) | undefined,
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
  return {
    failures: [],
    evidence: [
      `checkpoint repository identity, HEAD and clean state verified at ${head.stdout.trim()}`,
      "checkpoint behavioral verification remains agent-reported; existing system gates still apply",
    ],
  };
}
