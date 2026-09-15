import { createHash, randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
const ownerSchema = z
  .object({ attemptId: idSchema, supervisorSession: z.string().min(1) })
  .strict();
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
const startedSchema = z
  .object({
    attemptId: idSchema,
    startedAt: z.number().finite(),
    cancelledBeforeStart: z.boolean().optional(),
  })
  .strict();
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

/** Each settled attempt can publish only one successor; no mutable owner pointer is needed. */
function readOwnership(workOrder: LoopWorkOrder): {
  nextSlot: string;
  current?: Exclude<DelegationAttemptRead, { phase: "invalid" }>;
} {
  const root = dirname(attemptDirectory(workOrder, "unused"));
  if (!lstatSync(root).isDirectory()) throw new Error("invalid attempt directory");
  let slot = join(root, "first.json");
  let current: Exclude<DelegationAttemptRead, { phase: "invalid" }> | undefined;
  const seen = new Set<string>();
  for (;;) {
    let owner: z.infer<typeof ownerSchema>;
    try {
      owner = ownerSchema.parse(readRecord(slot));
    } catch (error) {
      if (!missing(error)) throw error;
      // Unlinked historical attempts or interrupted publication require reconciliation.
      if (current === undefined && readdirSync(root).length !== 0)
        throw new Error("unlinked delegation attempts require reconciliation");
      return { nextSlot: slot, ...(current === undefined ? {} : { current }) };
    }
    if (seen.has(owner.attemptId) || seen.size >= 10_000)
      throw new Error("invalid attempt ownership chain");
    seen.add(owner.attemptId);
    if (current !== undefined && current.phase !== "settled")
      throw new Error("unsettled attempt has a successor");
    const attempt = readDelegationAttempt(workOrder, owner.supervisorSession, owner.attemptId);
    if (attempt.phase === "invalid") throw new Error("attempt ownership requires reconciliation");
    current = attempt;
    slot = join(attemptDirectory(workOrder, owner.attemptId), "next.json");
  }
}

function ownsCurrentAttempt(workOrder: LoopWorkOrder, prepared: DelegationAttempt): boolean {
  try {
    const owner = readOwnership(workOrder).current?.prepared;
    return (
      owner?.attemptId === prepared.attemptId &&
      owner.supervisorSession === prepared.supervisorSession
    );
  } catch {
    return false;
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
  try {
    lstatSync(dir);
    throw new Error("attempt ID already exists");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const ownership = readOwnership(input.workOrder);
  if (ownership.current !== undefined && ownership.current.phase !== "settled")
    throw new Error("delegation attempt already owns this WorkOrder");
  // Reserve before preparing or enqueueing. A crash here keeps the owner visible,
  // so another process cannot infer that an absent queue item permits new work.
  if (
    !writeOnce(ownership.nextSlot, {
      attemptId: input.attemptId,
      supervisorSession: input.supervisorSession,
    })
  )
    throw new Error("delegation attempt reservation lost");
  mkdirSync(dir);
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
    let cancelledBeforeStart = false;
    try {
      const started = startedSchema.parse(readRecord(join(dir, "started.json")));
      if (started.attemptId !== attemptId) return { phase: "invalid" };
      cancelledBeforeStart = started.cancelledBeforeStart === true;
      if (!cancelledBeforeStart) phase = "started";
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
    return cancelledBeforeStart ? { phase: "invalid" } : { phase, prepared };
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
  if (current.phase !== "prepared" || !ownsCurrentAttempt(workOrder, prepared)) return false;
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
  ownsExecution: boolean,
): boolean {
  const current = readDelegationAttempt(workOrder, prepared.supervisorSession, prepared.attemptId);
  if (current.phase === "invalid") throw new Error("invalid attempt settlement");
  if (current.phase === "settled") return false;
  if (!ownsCurrentAttempt(workOrder, prepared))
    throw new Error("attempt does not own this WorkOrder");
  if (current.phase === "prepared" && result.status === 0)
    throw new Error("unstarted attempt cannot succeed");
  if (current.phase === "started" && !ownsExecution) return false;
  // A pre-start failure competes with start for the same exclusive event file.
  // Once start wins, only its claimant can settle the transport.
  if (
    current.phase === "prepared" &&
    !writeOnce(join(attemptDirectory(workOrder, prepared.attemptId), "started.json"), {
      attemptId: prepared.attemptId,
      startedAt: now,
      cancelledBeforeStart: true,
    })
  )
    return false;
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
