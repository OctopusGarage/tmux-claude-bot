import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { JsonMapStore } from "../infra/json-map-store.js";
import type {
  LoopRemoteBranchEvidenceStatus,
  LoopRemoteBranchEvidenceWriter,
} from "./remote-branch-reconciliation.js";

export type LoopRemoteBranchReconciliationEvidence = {
  id: string;
  repository: string;
  branch: string;
  sha: string;
  pullRequestNumber?: number;
  action: "delete-remote-branch";
  cleanupReason: string;
  status: LoopRemoteBranchEvidenceStatus;
  startedAt: number;
  completedAt?: number;
  reason?: string;
};

const MAX_RECORDS = 500;

export class LoopRemoteBranchReconciliationStore implements LoopRemoteBranchEvidenceWriter {
  private readonly records = new JsonMapStore<LoopRemoteBranchReconciliationEvidence>(
    "loop-remote-branch-reconciliation.json",
  );

  begin(input: Parameters<LoopRemoteBranchEvidenceWriter["begin"]>[0]): { id: string } {
    const id = evidenceId(input);
    this.records.set(id, {
      id,
      repository: input.repository,
      branch: input.branch,
      sha: input.sha,
      ...(input.pullRequestNumber === undefined
        ? {}
        : { pullRequestNumber: input.pullRequestNumber }),
      action: "delete-remote-branch",
      cleanupReason: input.reason,
      status: "intent",
      startedAt: input.now,
    });
    this.prune();
    return { id };
  }

  finish(id: string, input: Parameters<LoopRemoteBranchEvidenceWriter["finish"]>[1]): void {
    const existing = this.records.get(id);
    if (existing === undefined) throw new Error("Loop remote branch cleanup intent is missing");
    this.records.set(id, {
      ...existing,
      status: input.status,
      completedAt: input.now,
      reason: sanitizeEvidence(input.reason),
    });
  }

  lookup(input: Parameters<LoopRemoteBranchEvidenceWriter["lookup"]>[0]) {
    return this.list().find(
      (record) =>
        record.repository === input.repository &&
        record.branch === input.branch &&
        record.sha === input.sha &&
        record.pullRequestNumber === input.pullRequestNumber,
    )?.status;
  }

  list(): LoopRemoteBranchReconciliationEvidence[] {
    return this.records
      .sortedEntries()
      .map(([, record]) => record)
      .sort((left, right) => right.startedAt - left.startedAt || left.id.localeCompare(right.id));
  }

  private prune(): void {
    for (const record of this.list().slice(MAX_RECORDS)) this.records.delete(record.id);
  }
}

function evidenceId(input: {
  repository: string;
  branch: string;
  sha: string;
  pullRequestNumber?: number;
  now: number;
}): string {
  return createHash("sha256")
    .update(
      [
        input.repository,
        input.branch,
        input.sha,
        input.pullRequestNumber ?? "none",
        input.now,
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 24);
}

function sanitizeEvidence(value: string): string {
  return value
    .replace(/(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replaceAll(homedir(), "~")
    .replace(/\/Users\/[^/\s]+/g, "~")
    .replace(/https:\/\/[^/@\s]+@/gi, "https://<redacted>@")
    .slice(0, 500);
}
