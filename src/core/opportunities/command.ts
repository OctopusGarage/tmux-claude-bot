import type { HandlerDeps } from "../deps.js";
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
  _deps: HandlerDeps,
  _scope: string,
  arg: string,
): Promise<OpportunityCommandResult> {
  const [verbRaw, id] = arg.trim().split(/\s+/, 2);
  const verb = verbRaw?.toLowerCase() || "list";
  const store = new OpportunityStore();

  if (verb === "list") {
    return { tone: "info", body: formatOpportunityList(store.list()) };
  }
  if (!id) {
    return { tone: "err", body: opportunityUsage() };
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
  return {
    tone: "err",
    body: opportunityUsage(),
  };
}

function opportunityUsage(): string {
  return "Usage: /opportunity list|show|discuss|dismiss|snooze <number|id>. Use Autopilot after discussion to delegate confirmed work.";
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
