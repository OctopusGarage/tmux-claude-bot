import { OpportunityStore } from "./store.js";

export function markImplementedOpportunitiesForCompletedDelegation(input: {
  runId: string;
  resultStatus: string;
  opportunityIds?: string[];
  store?: OpportunityStore;
  now?: number;
}): string[] {
  if (input.resultStatus !== "completed") return [];

  const store = input.store ?? new OpportunityStore();
  const explicitIds = input.opportunityIds ?? [];
  const delegatedIds = store
    .list()
    .filter((suggestion) => suggestion.delegatedRunId === input.runId)
    .map((suggestion) => suggestion.id);
  const ids = [...new Set([...explicitIds, ...delegatedIds])];
  const implemented: string[] = [];
  const now = input.now ?? Date.now();

  for (const id of ids) {
    const updated = store.updateStatus(id, "implemented", now, {
      delegatedRunId: input.runId,
    });
    if (updated !== null) implemented.push(id);
  }

  return implemented;
}
