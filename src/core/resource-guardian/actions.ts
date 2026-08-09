import { redactSecrets } from "../../shared/utils/logger.js";
import { tildeifyHome } from "../../shared/utils/path.js";
import { sameProcessInstance } from "./ownership.js";
import type { ProcessOwnership } from "./types.js";

/** Loop WorkOrders have no durable priority today; keep their reduction order neutral. */
export const DEFAULT_RESOURCE_ACTION_PRIORITY = 1_000;

/** Produce evidence safe for durable records and notifications. */
export function sanitizeResourceActionReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return tildeifyHome(
    redactSecrets(raw)
      .replace(/\b(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
      .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, "<path>"),
  ).slice(0, 500);
}

export type ResourceActionCandidate = ProcessOwnership & {
  /** Only active delegated tasks have the cooperative cancellation capability. */
  taskKind?: string;
  cancellable?: boolean;
  /** Smaller values are lower priority and are reduced first. */
  normalizedPriority?: number;
  /** Backwards-compatible input seam for callers that have not normalized yet. */
  taskPriority?: number;
};

export type ResourceActionPlan =
  | { kind: "none" }
  | { kind: "reduce-load"; candidate: ResourceActionCandidate };

export function planResourceActions(input: {
  mode: "observe" | "protect";
  pressure: "healthy" | "elevated" | "critical" | "emergency" | "recovering";
  circuit: "open" | "heavy-closed" | "background-closed";
  candidates: readonly ResourceActionCandidate[];
}): ResourceActionPlan {
  if (
    input.mode !== "protect" ||
    input.pressure !== "emergency" ||
    input.circuit !== "background-closed"
  ) {
    return { kind: "none" };
  }
  const candidates = input.candidates
    .filter(isSafeCandidate)
    .sort(
      (left, right) =>
        right.process.cpuPct - left.process.cpuPct ||
        priorityOf(left) - priorityOf(right) ||
        left.process.startedAt.localeCompare(right.process.startedAt),
    );
  const candidate = candidates[0];
  return candidate === undefined ? { kind: "none" } : { kind: "reduce-load", candidate };
}

export type ResourceActionExecution = {
  outcome: "skipped" | "completed" | "failed";
  reason: string;
};

export async function executeResourceActions(input: {
  plan: ResourceActionPlan;
  reconcile(): Promise<void>;
  cancel(runId: string): Promise<{ status: "cancelled" | "not-found"; reason?: string }>;
  wait(): Promise<void>;
  collect(): Promise<readonly ProcessOwnership[]>;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
}): Promise<ResourceActionExecution> {
  if (input.plan.kind === "none") return { outcome: "skipped", reason: "no safe resource action" };
  const candidate = input.plan.candidate;
  try {
    await input.reconcile();
  } catch (error) {
    return {
      outcome: "failed",
      reason: sanitizeResourceActionReason(`reconciliation failed: ${String(error)}`),
    };
  }
  if (candidate.classification === "bot-active") {
    if (
      candidate.workOrderId === undefined ||
      candidate.taskKind !== "active-delegated-task" ||
      candidate.cancellable !== true
    )
      return { outcome: "failed", reason: "active candidate is not cancellable delegated work" };
    try {
      const cancellation = await input.cancel(candidate.workOrderId);
      if (cancellation.status !== "cancelled") {
        return {
          outcome: "failed",
          reason: cancellation.reason ?? "cooperative cancellation not found",
        };
      }
    } catch (error) {
      return {
        outcome: "failed",
        reason: sanitizeResourceActionReason(`cancellation failed: ${String(error)}`),
      };
    }
  }
  let afterGrace: ProcessOwnership | undefined;
  try {
    await input.wait();
    afterGrace = findRevalidatedCandidate(candidate, await input.collect());
  } catch (error) {
    return {
      outcome: "failed",
      reason: sanitizeResourceActionReason(`grace revalidation failed: ${String(error)}`),
    };
  }
  if (afterGrace === undefined)
    return { outcome: "skipped", reason: "candidate did not become safely terminal" };
  try {
    await input.signal(afterGrace.process.pid, "SIGTERM");
    await input.wait();
    const afterTerm = findRevalidatedCandidate(candidate, await input.collect());
    if (afterTerm === undefined)
      return { outcome: "completed", reason: "TERM completed without KILL" };
    await input.signal(afterTerm.process.pid, "SIGKILL");
    await input.wait();
    const afterKill = findRevalidatedCandidate(candidate, await input.collect());
    return afterKill === undefined
      ? { outcome: "completed", reason: "KILL confirmed process absent" }
      : { outcome: "failed", reason: "KILL sent but process remains" };
  } catch (error) {
    return {
      outcome: "failed",
      reason: sanitizeResourceActionReason(`TERM/KILL revalidation failed: ${String(error)}`),
    };
  }
}

function isSafeCandidate(candidate: ResourceActionCandidate): boolean {
  if (!candidate.strong) return false;
  if (candidate.classification === "bot-terminal" || candidate.classification === "bot-stale")
    return true;
  return (
    candidate.classification === "bot-active" &&
    candidate.taskKind === "active-delegated-task" &&
    candidate.cancellable === true
  );
}

function priorityOf(candidate: ResourceActionCandidate): number {
  return candidate.normalizedPriority ?? candidate.taskPriority ?? DEFAULT_RESOURCE_ACTION_PRIORITY;
}

function findRevalidatedCandidate(
  original: ResourceActionCandidate,
  ownership: readonly ProcessOwnership[],
): ProcessOwnership | undefined {
  return ownership.find(
    (current) =>
      current.strong &&
      (current.classification === "bot-terminal" || current.classification === "bot-stale") &&
      sameProcessInstance(original.process, current.process) &&
      current.workOrderId === original.workOrderId &&
      (original.session === undefined || current.session === original.session) &&
      (original.leaseId === undefined || current.leaseId === original.leaseId),
  );
}
