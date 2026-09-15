import { createHash, randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";
import { LOOP_RUN_ARTIFACTS } from "./artifacts.js";
import {
  captureFinalSummaryFreshness,
  readFreshSupervisorFinalSummary,
} from "./final-summary-freshness.js";
import {
  buildIterationCheckpointTemplate,
  iterationCheckpointPath,
  readIterationCheckpoint,
} from "./iteration-checkpoint.js";
import type { LoopRunCommandResult } from "./run.js";
import type { LoopWorkOrder } from "./work-order-contract.js";

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const preparedSchema = z
  .object({
    schemaVersion: z.literal(1),
    attemptId: idSchema,
    workOrderId: z.string().min(1),
    contractHash: hashSchema,
    supervisorSession: z.string().min(1),
    promptHash: hashSchema,
    queuedAt: z.number().finite(),
    freshness: z
      .object({ excludedFileVersion: hashSchema.optional() })
      .strict()
      .transform((value): { excludedFileVersion?: string } =>
        value.excludedFileVersion === undefined
          ? {}
          : { excludedFileVersion: value.excludedFileVersion },
      ),
    checkpoint: z.string().max(1_048_576),
  })
  .strict();
const startedSchema = z.object({ attemptId: idSchema, startedAt: z.number().finite() }).strict();
const settledSchema = z
  .object({
    attemptId: idSchema,
    settledAt: z.number().finite(),
    status: z.number().int(),
    cancelled: z.boolean(),
    output: z.string().max(16_000),
    checkpoint: z.string().max(1_048_576),
    finalSummary: z.string().max(1_048_576),
  })
  .strict();
export type DelegationAttempt = z.infer<typeof preparedSchema>;
export type DelegationAttemptRead =
  | { phase: "invalid" }
  | { phase: "prepared" | "started"; prepared: DelegationAttempt }
  | { phase: "settled"; prepared: DelegationAttempt; settled: z.infer<typeof settledSchema> };

function attemptDirectory(workOrder: LoopWorkOrder, attemptId: string): string {
  idSchema.parse(attemptId);
  const checkpoint = iterationCheckpointPath(workOrder);
  if (checkpoint === null) throw new Error("unsupported delegation attempt");
  return join(dirname(checkpoint), LOOP_RUN_ARTIFACTS.iterationAttempts, attemptId);
}

function readRecord(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 2_200_000) throw new Error("invalid attempt record");
  return JSON.parse(readFileSync(path, "utf8"));
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Publish a complete record atomically without replacing an existing event. */
function writeOnce(path: string, record: unknown): boolean {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileAtomicSync(temporary, JSON.stringify(record), { mode: 0o600 });
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function prepareDelegationAttempt(input: {
  workOrder: LoopWorkOrder;
  attemptId: string;
  supervisorSession: string;
  prompt: string;
  now: number;
}): DelegationAttempt | undefined {
  if (iterationCheckpointPath(input.workOrder) === null) return undefined;
  const dir = attemptDirectory(input.workOrder, input.attemptId);
  mkdirSync(dirname(dir), { recursive: true });
  if (!lstatSync(dirname(dir)).isDirectory()) throw new Error("invalid attempt directory");
  mkdirSync(dir);
  const prepared = preparedSchema.parse({
    schemaVersion: 1,
    attemptId: input.attemptId,
    workOrderId: input.workOrder.id,
    contractHash: buildIterationCheckpointTemplate(input.workOrder).contractHash,
    supervisorSession: input.supervisorSession,
    promptHash: createHash("sha256").update(input.prompt).digest("hex"),
    queuedAt: input.now,
    freshness: captureFinalSummaryFreshness(input.workOrder) ?? {},
    checkpoint: JSON.stringify(readIterationCheckpoint(input.workOrder)),
  });
  if (!writeOnce(join(dir, "prepared.json"), prepared)) throw new Error("attempt already prepared");
  return prepared;
}

export function readDelegationAttempt(
  workOrder: LoopWorkOrder,
  supervisorSession: string,
  attemptId: string,
): DelegationAttemptRead {
  try {
    const dir = attemptDirectory(workOrder, attemptId);
    if (!lstatSync(dir).isDirectory() || !lstatSync(dirname(dir)).isDirectory())
      return { phase: "invalid" };
    const prepared = preparedSchema.parse(readRecord(join(dir, "prepared.json")));
    if (
      prepared.attemptId !== attemptId ||
      prepared.supervisorSession !== supervisorSession ||
      prepared.workOrderId !== workOrder.id ||
      prepared.contractHash !== buildIterationCheckpointTemplate(workOrder).contractHash
    )
      return { phase: "invalid" };
    let phase: "prepared" | "started" = "prepared";
    try {
      const started = startedSchema.parse(readRecord(join(dir, "started.json")));
      if (started.attemptId !== attemptId) return { phase: "invalid" };
      phase = "started";
    } catch (error) {
      if (!missing(error)) throw error;
    }
    try {
      const settled = settledSchema.parse(readRecord(join(dir, "settled.json")));
      if (settled.attemptId !== attemptId || (settled.status === 0 && phase !== "started"))
        return { phase: "invalid" };
      return { phase: "settled", prepared, settled };
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return { phase, prepared };
  } catch {
    return { phase: "invalid" };
  }
}

export function claimDelegationAttempt(
  workOrder: LoopWorkOrder,
  prepared: DelegationAttempt,
  now: number,
): boolean {
  const current = readDelegationAttempt(workOrder, prepared.supervisorSession, prepared.attemptId);
  if (current.phase !== "prepared") return false;
  return writeOnce(join(attemptDirectory(workOrder, prepared.attemptId), "started.json"), {
    attemptId: prepared.attemptId,
    startedAt: now,
  });
}

export function settleDelegationAttempt(
  workOrder: LoopWorkOrder,
  prepared: DelegationAttempt,
  result: LoopRunCommandResult,
  cancelled: boolean,
  now: number,
): boolean {
  const current = readDelegationAttempt(workOrder, prepared.supervisorSession, prepared.attemptId);
  if (current.phase === "invalid") throw new Error("invalid attempt settlement");
  if (current.phase === "settled") return false;
  if (current.phase === "prepared" && result.status === 0)
    throw new Error("unstarted attempt cannot succeed");
  return writeOnce(
    join(attemptDirectory(workOrder, prepared.attemptId), "settled.json"),
    settledSchema.parse({
      attemptId: prepared.attemptId,
      settledAt: now,
      status: result.status,
      cancelled,
      output: [result.stdout, result.stderr].filter(Boolean).join("\n").slice(-16_000),
      checkpoint: JSON.stringify(readIterationCheckpoint(workOrder)),
      finalSummary: JSON.stringify(readFreshSupervisorFinalSummary(workOrder, prepared.freshness)),
    }),
  );
}
