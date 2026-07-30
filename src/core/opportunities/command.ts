import { startActiveDelegatedTask } from "../autopilot/delegated-task.js";
import type { HandlerDeps } from "../deps.js";
import { createProjectFromPath } from "../projects/project-ops.js";
import { OpportunityStore } from "./store.js";
import {
  formatOpportunityDetail,
  formatOpportunityDiscussionPrompt,
  formatOpportunityList,
} from "./view.js";

export type OpportunityCommandResult = {
  tone: "info" | "ok" | "err" | "warn";
  body: string;
};

export async function runOpportunityCommand(
  deps: HandlerDeps,
  scope: string,
  arg: string,
): Promise<OpportunityCommandResult> {
  const [verbRaw, id] = arg.trim().split(/\s+/, 2);
  const verb = verbRaw?.toLowerCase() || "list";
  const store = new OpportunityStore();

  if (verb === "list") {
    return { tone: "info", body: formatOpportunityList(store.list()) };
  }
  if (!id) {
    return {
      tone: "err",
      body: "Usage: /opportunity list|show|discuss|delegate|dismiss|snooze <number|id>",
    };
  }
  const resolved = resolveOpportunityReference(store, id);
  if (resolved === null) {
    return {
      tone: "err",
      body: `Opportunity not found: ${id}. Use /opportunity list, then pass the list number or full id.`,
    };
  }
  const { suggestion, id: resolvedId } = resolved;

  if (verb === "show") {
    return { tone: "info", body: formatOpportunityDetail(suggestion) };
  }
  if (verb === "discuss") {
    store.updateStatus(resolvedId, "discussing");
    return { tone: "info", body: formatOpportunityDiscussionPrompt(suggestion) };
  }
  if (verb === "dismiss") {
    store.updateStatus(resolvedId, "dismissed");
    return { tone: "ok", body: `Dismissed opportunity ${resolvedId}.` };
  }
  if (verb === "snooze") {
    const snoozedUntil = Date.now() + 14 * 24 * 60 * 60 * 1000;
    store.updateStatus(resolvedId, "snoozed", Date.now(), { snoozedUntil });
    return {
      tone: "ok",
      body: `Snoozed opportunity ${resolvedId} until ${new Date(snoozedUntil).toISOString()}.`,
    };
  }
  if (verb === "delegate") {
    const opened = await createProjectFromPath(deps, scope, suggestion.projectPath);
    if (opened.status !== "created" && opened.status !== "switched") {
      const reason =
        opened.status === "invalid" ? `${opened.error}: ${opened.resolvedPath}` : opened.message;
      return { tone: "err", body: `Cannot open project for ${resolvedId}: ${reason}` };
    }
    const result = await startActiveDelegatedTask(deps, {
      session: opened.sessionName,
      requirement: buildDelegateRequirement(suggestion),
      opportunityIds: [resolvedId],
    });
    if (result.status === "queued") {
      store.updateStatus(resolvedId, "delegated", Date.now(), { delegatedRunId: result.runId });
      return {
        tone: "ok",
        body: [
          `Delegated opportunity ${resolvedId}.`,
          `runId: ${result.runId}`,
          `project: ${result.projectId}`,
          `supervisor: ${result.supervisorSession}`,
          ...(result.reportDir !== null ? [`report: ${result.reportDir}`] : []),
        ].join("\n"),
      };
    }
    return { tone: "err", body: `Delegate blocked: ${result.reason}` };
  }

  return {
    tone: "err",
    body: "Usage: /opportunity list|show|discuss|delegate|dismiss|snooze <number|id>",
  };
}

function resolveOpportunityReference(
  store: OpportunityStore,
  raw: string,
): { id: string; suggestion: NonNullable<ReturnType<OpportunityStore["get"]>> } | null {
  const direct = store.get(raw);
  if (direct !== null) return { id: raw, suggestion: direct };

  if (!/^[1-9]\d*$/.test(raw)) return null;
  const ordinal = Number(raw);
  if (!Number.isSafeInteger(ordinal)) return null;
  const visible = store
    .list()
    .filter(
      (suggestion) => suggestion.status !== "dismissed" && suggestion.status !== "implemented",
    );
  const suggestion = visible[ordinal - 1];
  return suggestion === undefined ? null : { id: suggestion.id, suggestion };
}

function buildDelegateRequirement(suggestion: {
  id: string;
  title: string;
  projectName: string;
  delegateRequirement: string;
  acceptanceCriteria: string[];
  nonGoals: string[];
  risks: string[];
}): string {
  return [
    `Implement the user-approved opportunity ${suggestion.id} for ${suggestion.projectName}.`,
    "",
    `Title: ${suggestion.title}`,
    "",
    "Requirement:",
    suggestion.delegateRequirement,
    "",
    "Acceptance criteria:",
    ...suggestion.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "Non-goals:",
    ...suggestion.nonGoals.map((item) => `- ${item}`),
    "",
    "Risks to check:",
    ...suggestion.risks.map((item) => `- ${item}`),
    "",
    "Complete the implementation through review, relevant tests, coverage review for touched risk paths, and any justified existing deterministic or agent-backed eval. Do not add unrelated product scope.",
  ].join("\n");
}
