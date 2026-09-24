import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    continuationsUsed: z.number().int().safe().nonnegative().default(0),
    lastContinuationSequence: z.number().int().safe().nonnegative().default(0),
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

export function readDelegationDeadline(workOrder: LoopWorkOrder): number | undefined {
  const checkpointPath = iterationCheckpointPath(workOrder);
  if (checkpointPath === null) return undefined;
  try {
    const path = join(dirname(checkpointPath), LOOP_RUN_ARTIFACTS.delegationBudget);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 16_384) return undefined;
    const state = budgetSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return state.contractHash === buildIterationCheckpointTemplate(workOrder).contractHash
      ? state.deadlineAt
      : undefined;
  } catch {
    return undefined;
  }
}

/** Reserve synchronously before dispatch; the WorkOrder queue owns execution serialization. */
export function reserveDelegationBudget(
  workOrder: LoopWorkOrder,
  timeoutMs: number,
  maxAttempts?: number,
  continuationSequence?: number,
  continuationFingerprint?: string,
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
    if (continuationSequence !== undefined) {
      if (
        !Number.isSafeInteger(continuationSequence) ||
        continuationSequence <= state.lastContinuationSequence
      ) {
        return deny("delegation continuation checkpoint sequence already consumed or invalid");
      }
      if (state.continuationsUsed >= Math.max(0, workOrder.maxRounds - 1)) {
        return deny("delegation continuation budget exhausted");
      }
      if (continuationFingerprint === undefined || !/^[a-f0-9]{64}$/.test(continuationFingerprint))
        return deny("delegation continuation fingerprint invalid");
      // Establish sticky checkpoint acceptance before granting another worker turn.
      const requiredPath = join(dirname(checkpointPath), LOOP_RUN_ARTIFACTS.checkpointRequired);
      const requirement = JSON.stringify({ schemaVersion: 1, contractHash });
      try {
        const stat = lstatSync(requiredPath);
        if (
          !stat.isFile() ||
          stat.size > 1024 ||
          readFileSync(requiredPath, "utf8") !== requirement
        ) {
          return deny("delegation continuation checkpoint requirement invalid");
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        writeFileAtomicSync(requiredPath, requirement);
      }
      // Claim before granting a turn. An interrupted reservation fails closed on replay.
      const evidenceDir = join(dirname(checkpointPath), LOOP_RUN_ARTIFACTS.continuationEvidence);
      mkdirSync(evidenceDir, { recursive: true });
      try {
        writeFileSync(
          join(evidenceDir, `${continuationFingerprint}.json`),
          JSON.stringify({ contractHash, sequence: continuationSequence }),
          { flag: "wx" },
        );
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST")
          return deny("delegation continuation rejected repeated checkpoint evidence");
        throw error;
      }
      state.continuationsUsed += 1;
      state.lastContinuationSequence = continuationSequence;
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
