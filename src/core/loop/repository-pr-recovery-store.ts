import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { JsonMapStore } from "../infra/json-map-store.js";

export type RepositoryPullRequestRecoveryActionKind =
  | "approve-workflow"
  | "rerun-workflow"
  | "configure-private-fork-workflows"
  | "mark-ready";

export type RepositoryPullRequestRecoveryEvidence = {
  id: string;
  repository: string;
  number: number;
  headSha: string;
  action: RepositoryPullRequestRecoveryActionKind;
  runId?: number;
  status: "intent" | "succeeded" | "failed";
  startedAt: number;
  completedAt?: number;
  reason?: string;
};

export type RepositoryPullRequestRecoveryEvidenceWriter = {
  begin(input: {
    repository: string;
    number: number;
    headSha: string;
    action: RepositoryPullRequestRecoveryActionKind;
    runId?: number;
    now: number;
  }): { id: string };
  finish(id: string, input: { status: "succeeded" | "failed"; reason: string; now: number }): void;
  lookup?(input: {
    repository: string;
    number: number;
    headSha: string;
    action: RepositoryPullRequestRecoveryActionKind;
    runId?: number;
  }): RepositoryPullRequestRecoveryEvidence["status"] | undefined;
};

const MAX_RECORDS = 500;

export class RepositoryPullRequestRecoveryStore
  implements RepositoryPullRequestRecoveryEvidenceWriter
{
  private readonly records = new JsonMapStore<RepositoryPullRequestRecoveryEvidence>(
    "repository-pr-recovery.json",
  );

  begin(input: Parameters<RepositoryPullRequestRecoveryEvidenceWriter["begin"]>[0]): {
    id: string;
  } {
    const id = recoveryEvidenceId(input);
    this.records.set(id, {
      id,
      repository: input.repository,
      number: input.number,
      headSha: input.headSha,
      action: input.action,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      status: "intent",
      startedAt: input.now,
    });
    this.prune();
    return { id };
  }

  finish(
    id: string,
    input: Parameters<RepositoryPullRequestRecoveryEvidenceWriter["finish"]>[1],
  ): void {
    const existing = this.records.get(id);
    if (existing === undefined) throw new Error("repository PR recovery intent is missing");
    this.records.set(id, {
      ...existing,
      status: input.status,
      completedAt: input.now,
      reason: sanitizeEvidence(input.reason),
    });
  }

  lookup(input: {
    repository: string;
    number: number;
    headSha: string;
    action: RepositoryPullRequestRecoveryActionKind;
    runId?: number;
  }): RepositoryPullRequestRecoveryEvidence["status"] | undefined {
    return this.list().find(
      (record) =>
        record.repository === input.repository &&
        record.number === input.number &&
        record.headSha === input.headSha &&
        record.action === input.action &&
        record.runId === input.runId,
    )?.status;
  }

  list(): RepositoryPullRequestRecoveryEvidence[] {
    return this.records
      .sortedEntries()
      .map(([, record]) => record)
      .sort((left, right) => right.startedAt - left.startedAt || left.id.localeCompare(right.id));
  }

  private prune(): void {
    const stale = this.list().slice(MAX_RECORDS);
    for (const record of stale) this.records.delete(record.id);
  }
}

function recoveryEvidenceId(input: {
  repository: string;
  number: number;
  headSha: string;
  action: string;
  runId?: number;
  now: number;
}): string {
  return createHash("sha256")
    .update(
      [
        input.repository,
        input.number,
        input.headSha,
        input.action,
        input.runId ?? "",
        input.now,
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 24);
}

function sanitizeEvidence(value: string): string {
  const home = homedir();
  return value
    .replace(/(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replaceAll(home, "~")
    .replace(/\/Users\/[^/\s]+/g, "~")
    .slice(0, 500);
}
