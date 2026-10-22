import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import {
  parseSupervisorFinalSummaryFile,
  parseSupervisorFinalSummaryJson,
} from "./final-summary-contract.js";
import { iterationCheckpointPath } from "./iteration-checkpoint.js";
import type { LoopWorkOrder, ParseSupervisorFinalSummaryResult } from "./work-order-contract.js";

export type FinalSummaryFreshness = { excludedFileVersion?: string };

/** Capture bytes and filesystem identity from one regular-file descriptor. */
function summarySnapshot(workOrder: LoopWorkOrder): { text: string; version: string } | undefined {
  if (workOrder.finalSummaryPath === undefined) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(
      workOrder.finalSummaryPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > 1_048_576n) return undefined;
    const text = readFileSync(fd, "utf8");
    if (Buffer.byteLength(text, "utf8") > 1_048_576) return undefined;
    const version = createHash("sha256")
      .update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:`)
      .update(text)
      .digest("hex");
    return { text, version };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function captureFinalSummaryFreshness(
  workOrder: LoopWorkOrder,
): FinalSummaryFreshness | undefined {
  if (iterationCheckpointPath(workOrder) === null) return undefined;
  const snapshot = summarySnapshot(workOrder);
  return snapshot === undefined ? {} : { excludedFileVersion: snapshot.version };
}

export function readFreshSupervisorFinalSummary(
  workOrder: LoopWorkOrder,
  freshness: FinalSummaryFreshness | undefined,
): ParseSupervisorFinalSummaryResult {
  if (freshness === undefined) return parseSupervisorFinalSummaryFile(workOrder);
  const snapshot = summarySnapshot(workOrder);
  if (snapshot === undefined || snapshot.version === freshness.excludedFileVersion) {
    return { ok: false, reason: "missing-final-marker" };
  }
  return parseSupervisorFinalSummaryJson(workOrder, snapshot.text);
}
