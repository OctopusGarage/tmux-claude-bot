import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { LOOP_RUN_ARTIFACTS, loopRunArtifactPath } from "./artifacts.js";
import type { LoopWorkOrder } from "./work-order-contract.js";

const text = z
  .string()
  .min(1)
  .max(4_000)
  .refine((value) => value.trim().length > 0);
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const evidenceSchema = z
  .object({
    source: z.literal("agent-reported"),
    revision,
    command: text,
    result: z.enum(["passed", "failed", "skipped", "not-run"]),
    artifact: text,
  })
  .strict();
const checkpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    workOrderId: text,
    projectId: text,
    contractHash: z.string().regex(/^[a-f0-9]{64}$/),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    repositoryRevision: revision.nullable(),
    worktreeDirty: z.boolean().nullable(),
    items: z
      .array(
        z
          .object({
            id: text,
            description: text,
            status: z.enum(["pending", "reported-passed", "blocked"]),
            evidence: z.array(evidenceSchema).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    nextAction: text,
  })
  .strict();

type IterationCheckpoint = z.infer<typeof checkpointSchema>;
export type IterationCheckpointRead =
  | { status: "absent" }
  | { status: "invalid"; reason: string }
  | { status: "available"; checkpoint: IterationCheckpoint };

/** Include every persisted WorkOrder policy, independent of object key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Report identity for replay rejection, never independent acceptance evidence. */
export function checkpointProgressFingerprint(checkpoint: IterationCheckpoint): string {
  return hash({
    repositoryRevision: checkpoint.repositoryRevision,
    worktreeDirty: checkpoint.worktreeDirty,
    items: checkpoint.items
      .map((item) => ({
        id: item.id,
        status: item.status,
        evidence: [...new Set(item.evidence.map(canonicalJson))].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function iterationCheckpointPath(workOrder: LoopWorkOrder): string | null {
  if (workOrder.task?.kind !== "active-delegated-task" || workOrder.workspace !== undefined) {
    return null;
  }
  const finalSummary =
    workOrder.finalSummaryPath ??
    loopRunArtifactPath(workOrder.projectId, workOrder.id, "supervisorFinalSummary");
  return join(dirname(finalSummary), LOOP_RUN_ARTIFACTS.iterationCheckpoint);
}

export function buildIterationCheckpointTemplate(workOrder: LoopWorkOrder): IterationCheckpoint {
  const criteria = workOrder.planning?.acceptanceCriteria;
  const descriptions = criteria?.length ? criteria : [workOrder.goal];
  return {
    schemaVersion: 1,
    workOrderId: workOrder.id,
    projectId: workOrder.projectId,
    contractHash: hash(workOrder),
    sequence: 1,
    repositoryRevision: null,
    worktreeDirty: null,
    items: descriptions.map((description, index) => ({
      id: `acceptance-${index + 1}-${hash(description).slice(0, 12)}`,
      description,
      status: "pending",
      evidence: [],
    })),
    nextAction: "Inspect the repository and select the next required acceptance item.",
  };
}

function validateCheckpoint(workOrder: LoopWorkOrder, value: unknown): IterationCheckpointRead {
  const parsed = checkpointSchema.safeParse(value);
  if (!parsed.success) return { status: "invalid", reason: "invalid-checkpoint" };
  const checkpoint = parsed.data;
  const expected = buildIterationCheckpointTemplate(workOrder);
  if (
    checkpoint.workOrderId !== expected.workOrderId ||
    checkpoint.projectId !== expected.projectId ||
    checkpoint.contractHash !== expected.contractHash
  )
    return { status: "invalid", reason: "contract-mismatch" };

  const ids = new Set(checkpoint.items.map((item) => item.id));
  if (
    ids.size !== checkpoint.items.length ||
    checkpoint.items.length !== expected.items.length ||
    expected.items.some(
      (item) =>
        !checkpoint.items.some(
          (candidate) => candidate.id === item.id && candidate.description === item.description,
        ),
    )
  )
    return { status: "invalid", reason: "acceptance-items-mismatch" };

  for (const item of checkpoint.items) {
    if (item.evidence.some((evidence) => evidence.revision !== checkpoint.repositoryRevision)) {
      return { status: "invalid", reason: "evidence-revision-mismatch" };
    }
    if (
      item.status === "reported-passed" &&
      (checkpoint.repositoryRevision === null ||
        checkpoint.worktreeDirty !== false ||
        item.evidence.length === 0 ||
        item.evidence.some((evidence) => evidence.result !== "passed"))
    )
      return { status: "invalid", reason: "missing-passing-evidence" };
  }
  return { status: "available", checkpoint };
}

/** Agent-owned input is recovery context only, never system acceptance evidence. */
export function readIterationCheckpoint(workOrder: LoopWorkOrder): IterationCheckpointRead {
  const path = iterationCheckpointPath(workOrder);
  if (path === null) return { status: "absent" };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return { status: "invalid", reason: "not-checkpoint-file" };
    if (stat.size > 1_048_576) return { status: "invalid", reason: "checkpoint-too-large" };
    return validateCheckpoint(workOrder, JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "absent" };
    }
    return { status: "invalid", reason: "unreadable-checkpoint" };
  }
}

export function iterationCheckpointPolicy(workOrder: LoopWorkOrder): string[] {
  const path = iterationCheckpointPath(workOrder);
  if (path === null) return [];
  return [
    "",
    "Iteration checkpoint (single-repository active delegation):",
    `- Checkpoint path: ${JSON.stringify(path)}. This is an internal run artifact, outside the target repository.`,
    "- Before substantive work, read an existing checkpoint only if its WorkOrder identity, contractHash and complete acceptance-item list match the template below. Reinspect actual repository state; recorded progress is agent-reported, not system acceptance.",
    "- After each bounded slice and before context reset, write the complete checkpoint with atomic replacement (temporary sibling file followed by rename). Preserve every required item and increment sequence; it is a reported sequence, not an authoritative budget counter.",
    "- Set repositoryRevision to the full lowercase git HEAD hash and worktreeDirty from git status. Keep both null until observed. Record actual command, result and evidence artifact for each item; evidence source must remain agent-reported.",
    "- Each evidence revision must match repositoryRevision. After code changes, clear stale evidence and return affected items to pending until reverified. Use reported-passed only for a clean revision with nonempty evidence whose results are all passed. Record blocked work and its next action; do not omit or defer required items.",
    "- Checkpoints do not complete the WorkOrder, replace the final summary or bypass system gates. A checkpoint does not authorize another iteration or extend the existing budget. Keep existing cancellation and stop policies.",
    "- If a turn ends without a final summary, the runner may repeat the same prompt when a fresh partial checkpoint matches the actual repository and budget remains. It allows at most maxRounds minus one partial continuations across this WorkOrder. Re-read the checkpoint, advance pending work, and preserve the session. Unchanged sequences, blocked items or repository mismatches stop continuation; a sequence increase is reported progress, not proof of correctness.",
    "- Repeating previously consumed checkpoint evidence stops continuation, including after restart. Changing only the sequence, next-action wording, item order or evidence order/duplication does not establish new progress. Do not remove or modify system-owned continuation-evidence records.",
    "- Template (keep identity, contractHash, item IDs and descriptions unchanged):",
    JSON.stringify(buildIterationCheckpointTemplate(workOrder), null, 2),
  ];
}
