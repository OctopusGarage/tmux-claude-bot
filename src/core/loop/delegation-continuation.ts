import { resolve } from "node:path";
import { type IterationCheckpointRead, readIterationCheckpoint } from "./iteration-checkpoint.js";
import type { LoopGitInvocation, LoopRunCommandResult } from "./run.js";
import type { LoopWorkOrder } from "./work-order-contract.js";

type ContinuationDecision =
  | { kind: "finalize" }
  | { kind: "stop"; reason: string }
  | { kind: "continue"; sequence: number };

/** A checkpoint requests a turn; repository checks and the durable budget authorize it. */
export function inspectDelegationContinuation(
  workOrder: LoopWorkOrder,
  previous: IterationCheckpointRead,
  runGit: ((invocation: LoopGitInvocation) => LoopRunCommandResult) | undefined,
): ContinuationDecision {
  const current = readIterationCheckpoint(workOrder);
  const stop = (reason: string): ContinuationDecision => ({
    kind: "stop",
    reason: `checkpoint continuation stopped: ${reason}`,
  });
  if (current.status === "absent") {
    return previous.status === "absent" ? { kind: "finalize" } : stop("checkpoint disappeared");
  }
  if (current.status === "invalid") return stop(current.reason);
  const checkpoint = current.checkpoint;
  if (checkpoint.items.some((item) => item.status === "blocked"))
    return stop("required work is blocked");
  const pending = checkpoint.items.some((item) => item.status === "pending");
  if (
    pending &&
    previous.status === "available" &&
    checkpoint.sequence <= previous.checkpoint.sequence
  ) {
    return stop("checkpoint sequence did not advance");
  }
  if (runGit === undefined) return stop("repository adapter unavailable");
  try {
    const query = (args: string[]) => runGit({ cwd: workOrder.projectPath, args });
    const root = query(["rev-parse", "--show-toplevel"]);
    if (root.status !== 0 || resolve(root.stdout.trim()) !== resolve(workOrder.projectPath))
      return stop("repository toplevel mismatch or unavailable");
    const head = query(["rev-parse", "HEAD"]);
    if (head.status !== 0 || head.stdout.trim() !== checkpoint.repositoryRevision)
      return stop("repository HEAD differs from checkpoint or is unavailable");
    const status = query(["status", "--porcelain"]);
    if (status.status !== 0 || (status.stdout.trim() !== "") !== checkpoint.worktreeDirty)
      return stop("repository dirty state differs from checkpoint or is unavailable");
  } catch {
    return stop("repository inspection failed");
  }
  return pending ? { kind: "continue", sequence: checkpoint.sequence } : { kind: "finalize" };
}
