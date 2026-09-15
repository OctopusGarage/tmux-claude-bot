import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";
import { LOOP_RUN_ARTIFACTS } from "./artifacts.js";
import {
  buildIterationCheckpointTemplate,
  iterationCheckpointPath,
} from "./iteration-checkpoint.js";
import type { LoopWorkOrder } from "./work-order-contract.js";

const budgetSchema = z
  .object({
    schemaVersion: z.literal(1),
    contractHash: z.string(),
    deadlineAt: z.number().int().safe().positive(),
    revisionsUsed: z.number().int().safe().nonnegative(),
    revisionLimit: z.number().int().safe().nonnegative().nullable(),
  })
  .strict();

type Reservation =
  | { ok: true; timeoutMs: number; attempt?: number; maxAttempts?: number }
  | {
      ok: false;
      status: "dispatch-failed" | "dispatch-timeout";
      reason: string;
      output: string;
      finalSummaryRecovery: "disabled";
    };

/** Reserve synchronously before dispatch; the WorkOrder queue owns execution serialization. */
export function reserveDelegationBudget(
  workOrder: LoopWorkOrder,
  timeoutMs: number,
  maxAttempts?: number,
): Reservation {
  const checkpointPath = iterationCheckpointPath(workOrder);
  if (checkpointPath === null) return { ok: true, timeoutMs };
  const deny = (
    reason: string,
    status: "dispatch-failed" | "dispatch-timeout" = "dispatch-failed",
  ): Reservation => ({
    ok: false,
    status,
    reason,
    output: reason,
    finalSummaryRecovery: "disabled",
  });
  try {
    const path = join(dirname(checkpointPath), LOOP_RUN_ARTIFACTS.delegationBudget);
    const contractHash = buildIterationCheckpointTemplate(workOrder).contractHash;
    const now = Date.now();
    let state = budgetSchema.parse({
      schemaVersion: 1,
      contractHash,
      deadlineAt: now + timeoutMs,
      revisionsUsed: 0,
      revisionLimit: null,
    });
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 16_384) return deny("delegation budget state is invalid");
      state = budgetSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (state.contractHash !== contractHash) return deny("delegation budget contract mismatch");
    if (state.deadlineAt <= now) return deny("delegation deadline exhausted", "dispatch-timeout");
    if (maxAttempts !== undefined) {
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0)
        return deny("delegation revision limit is invalid");
      state.revisionLimit = Math.min(state.revisionLimit ?? maxAttempts, maxAttempts);
      if (state.revisionsUsed >= state.revisionLimit) {
        writeFileAtomicSync(path, JSON.stringify(state));
        return deny("delegation revision budget exhausted");
      }
      state.revisionsUsed += 1;
    }
    writeFileAtomicSync(path, JSON.stringify(state));
    return {
      ok: true,
      timeoutMs: Math.min(timeoutMs, state.deadlineAt - now),
      ...(maxAttempts !== undefined
        ? { attempt: state.revisionsUsed, maxAttempts: state.revisionLimit ?? maxAttempts }
        : {}),
    };
  } catch {
    return deny("delegation budget state is unreadable or invalid");
  }
}
