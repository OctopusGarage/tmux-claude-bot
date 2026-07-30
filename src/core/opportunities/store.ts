import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import { normalizeError } from "../../shared/utils/error.js";
import type {
  OpportunityDiscoveryReport,
  OpportunityStatus,
  OpportunitySuggestion,
  OpportunitySuggestionInput,
} from "./types.js";

type OpportunityIndex = Record<string, OpportunitySuggestion>;

const STORE_FILE = "opportunities/index.json";

export function opportunityReportPath(projectId: string, runId: string): string {
  return join(appStateDir(), "loop-runs", projectId, runId, "opportunities.json");
}

export class OpportunityStore {
  private readonly filePath: string;

  constructor(filePath = join(appStateDir(), STORE_FILE)) {
    this.filePath = filePath;
  }

  list(): OpportunitySuggestion[] {
    return Object.values(this.read()).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  get(id: string): OpportunitySuggestion | null {
    return this.read()[id] ?? null;
  }

  updateStatus(
    id: string,
    status: OpportunityStatus,
    now = Date.now(),
    extra: { snoozedUntil?: number; delegatedRunId?: string } = {},
  ): OpportunitySuggestion | null {
    const index = this.read();
    const existing = index[id];
    if (existing === undefined) return null;
    index[id] = {
      ...existing,
      status,
      updatedAt: now,
      ...(extra.snoozedUntil !== undefined ? { snoozedUntil: extra.snoozedUntil } : {}),
      ...(extra.delegatedRunId !== undefined ? { delegatedRunId: extra.delegatedRunId } : {}),
    };
    this.write(index);
    return index[id] ?? null;
  }

  upsertDiscoveryReport(input: {
    report: OpportunityDiscoveryReport;
    projectPath: string;
    runId: string;
    cooldownDays: number;
    now?: number;
  }): OpportunitySuggestion[] {
    const now = input.now ?? Date.now();
    const index = this.read();
    const cooldownMs = input.cooldownDays * 24 * 60 * 60 * 1000;
    const accepted: OpportunitySuggestion[] = [];

    for (const suggestion of input.report.suggestions) {
      const fingerprint = opportunityFingerprint(input.report.projectId, suggestion);
      const duplicate = Object.values(index).find(
        (candidate) =>
          candidate.projectId === input.report.projectId &&
          candidate.fingerprint === fingerprint &&
          candidate.updatedAt + cooldownMs > now &&
          candidate.status !== "implemented",
      );
      if (duplicate !== undefined) continue;
      const id = opportunityId(input.report.projectId, fingerprint, now);
      const stored: OpportunitySuggestion = {
        ...suggestion,
        id,
        projectId: input.report.projectId,
        projectName: input.report.projectName,
        projectPath: input.projectPath,
        runId: input.runId,
        discoveredAt: now,
        updatedAt: now,
        fingerprint,
        status: "proposed",
      };
      index[id] = stored;
      accepted.push(stored);
    }

    if (accepted.length > 0) this.write(index);
    return accepted;
  }

  private read(): OpportunityIndex {
    if (!existsSync(this.filePath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      if (!isRecord(parsed)) return {};
      const index: OpportunityIndex = {};
      for (const [id, value] of Object.entries(parsed)) {
        if (isOpportunitySuggestion(value)) index[id] = value;
      }
      return index;
    } catch (err) {
      throw new Error(`failed to read opportunity store: ${normalizeError(err).message}`);
    }
  }

  private write(index: OpportunityIndex): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(index, null, 2)}\n`);
  }
}

export function parseOpportunityDiscoveryReportFile(
  filePath: string | undefined,
): OpportunityDiscoveryReport | null {
  if (filePath === undefined || !existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return isOpportunityDiscoveryReport(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function opportunityId(projectId: string, fingerprint: string, now: number): string {
  const date = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
  return `${projectId}-${date}-${shortHash(fingerprint, 8)}`;
}

function opportunityFingerprint(projectId: string, suggestion: OpportunitySuggestionInput): string {
  return shortHash(
    [
      projectId,
      suggestion.category,
      normalizeText(suggestion.title),
      normalizeText(suggestion.problem),
      normalizeText(suggestion.recommendedApproach),
    ].join("\n"),
    16,
  );
}

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isOpportunityDiscoveryReport(value: unknown): value is OpportunityDiscoveryReport {
  return (
    isRecord(value) &&
    typeof value.projectId === "string" &&
    typeof value.projectName === "string" &&
    typeof value.generatedAt === "string" &&
    (value.coverage === "complete" ||
      value.coverage === "partial" ||
      value.coverage === "unknown") &&
    isStringArray(value.checkedSignals) &&
    isStringArray(value.skippedSignals) &&
    Array.isArray(value.suggestions) &&
    value.suggestions.every(isOpportunitySuggestionInput)
  );
}

function isOpportunitySuggestion(value: unknown): value is OpportunitySuggestion {
  if (!isRecord(value)) return false;
  if (!isOpportunitySuggestionInput(value)) return false;
  const record: Record<string, unknown> = value;
  return (
    typeof record.id === "string" &&
    typeof record.projectId === "string" &&
    typeof record.projectName === "string" &&
    typeof record.projectPath === "string" &&
    typeof record.runId === "string" &&
    typeof record.discoveredAt === "number" &&
    typeof record.updatedAt === "number" &&
    typeof record.fingerprint === "string" &&
    isOpportunityStatus(record.status)
  );
}

function isOpportunitySuggestionInput(value: unknown): value is OpportunitySuggestionInput {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    isOpportunityCategory(value.category) &&
    isOpportunityConfidence(value.confidence) &&
    typeof value.problem === "string" &&
    typeof value.whyNow === "string" &&
    typeof value.value === "string" &&
    isStringArray(value.evidence) &&
    typeof value.recommendedApproach === "string" &&
    isStringArray(value.alternatives) &&
    isStringArray(value.acceptanceCriteria) &&
    isStringArray(value.risks) &&
    isStringArray(value.nonGoals) &&
    (value.estimatedComplexity === "small" ||
      value.estimatedComplexity === "medium" ||
      value.estimatedComplexity === "large") &&
    typeof value.delegateRequirement === "string"
  );
}

function isOpportunityCategory(value: unknown): boolean {
  return (
    value === "product-feature" ||
    value === "workflow-automation" ||
    value === "developer-experience" ||
    value === "reliability" ||
    value === "architecture" ||
    value === "testing" ||
    value === "security"
  );
}

function isOpportunityConfidence(value: unknown): boolean {
  return value === "low" || value === "medium" || value === "high";
}

function isOpportunityStatus(value: unknown): value is OpportunityStatus {
  return (
    value === "proposed" ||
    value === "discussing" ||
    value === "delegated" ||
    value === "dismissed" ||
    value === "snoozed" ||
    value === "implemented"
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
