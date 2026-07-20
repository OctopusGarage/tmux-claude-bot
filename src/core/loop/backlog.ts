import { createHash } from "node:crypto";
import { JsonMapStore } from "../infra/json-map-store.js";
import type { LoopRunSummary } from "./run.js";

export type LoopBacklogItem = {
  id: string;
  projectId: string;
  runId?: string;
  text: string;
  status: "open" | "closed";
  createdAt: number;
  closedAt?: number;
};

function itemId(projectId: string, text: string): string {
  const digest = createHash("sha256").update(`${projectId}\0${text}`).digest("hex").slice(0, 12);
  return `${projectId}-${digest}`;
}

export class LoopBacklogStore {
  private readonly items = new JsonMapStore<LoopBacklogItem>("loop_backlog.json");

  addSuggestions(summary: LoopRunSummary, now: number, runId?: string): LoopBacklogItem[] {
    return this.addItems(summary.projectId, summary.suggestedBotImprovements, now, runId);
  }

  addFollowUps(
    projectId: string,
    followUps: readonly string[],
    now: number,
    runId?: string,
  ): LoopBacklogItem[] {
    return this.addItems(projectId, followUps, now, runId);
  }

  private addItems(
    projectId: string,
    texts: readonly string[],
    now: number,
    runId?: string,
  ): LoopBacklogItem[] {
    const added: LoopBacklogItem[] = [];
    for (const text of texts) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      const id = itemId(projectId, trimmed);
      if (this.items.has(id)) continue;
      const item: LoopBacklogItem = {
        id,
        projectId,
        text: trimmed,
        status: "open",
        createdAt: now,
        ...(runId !== undefined ? { runId } : {}),
      };
      this.items.set(id, item);
      added.push(item);
    }
    return added;
  }

  list(opts: { all?: boolean } = {}): LoopBacklogItem[] {
    return this.items
      .sortedEntries()
      .map(([, item]) => item)
      .filter((item) => opts.all === true || item.status === "open")
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  close(id: string, now: number): boolean {
    const item = this.items.get(id);
    if (item === undefined) return false;
    this.items.set(id, { ...item, status: "closed", closedAt: now });
    return true;
  }
}
