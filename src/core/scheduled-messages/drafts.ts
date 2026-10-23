import { randomBytes } from "node:crypto";
import type { ScheduledMessageService } from "./service.js";
import { parseScheduleTime } from "./time.js";
import {
  type ScheduledMessageRecord,
  type ScheduledTarget,
  type ScheduleOwner,
  sameOwner,
} from "./types.js";
export type ScheduleDraft = {
  id: string;
  revision: number;
  owner: ScheduleOwner;
  target: ScheduledTarget;
  text: string;
  dueAt?: number;
  timezone?: string;
  expiresAt: number;
};
type StoredDraft = {
  draft: ScheduleDraft;
  prompts: Map<string, "text" | "time">;
  confirmed?: ScheduledMessageRecord;
  pending?: Promise<ScheduledMessageRecord>;
};
export class ScheduleDrafts {
  private readonly drafts = new Map<string, StoredDraft>();
  constructor(private readonly now: () => number = Date.now) {}
  create(owner: ScheduleOwner, target: ScheduledTarget): ScheduleDraft {
    for (const [id, entry] of this.drafts) {
      if (entry.draft.expiresAt <= this.now()) this.drafts.delete(id);
    }
    const draft: ScheduleDraft = {
      id: randomBytes(6).toString("hex"),
      revision: 0,
      owner: structuredClone(owner),
      target: structuredClone(target),
      text: "",
      expiresAt: this.now() + 30 * 60000,
    };
    this.drafts.set(draft.id, { draft, prompts: new Map() });
    return structuredClone(draft);
  }
  private entry(owner: ScheduleOwner, id: string): StoredDraft | undefined {
    const entry = this.drafts.get(id);
    if (entry && entry.draft.expiresAt <= this.now()) {
      this.drafts.delete(id);
      return undefined;
    }
    return entry && sameOwner(owner, entry.draft.owner) ? entry : undefined;
  }
  get(owner: ScheduleOwner, id: string): ScheduleDraft | undefined {
    const entry = this.entry(owner, id);
    return entry ? structuredClone(entry.draft) : undefined;
  }
  update(
    owner: ScheduleOwner,
    id: string,
    patch: {
      target?: ScheduledTarget;
      text?: string;
      when?: string | { dueAt: number; timezone: string };
    },
    expectedRevision?: number,
  ): ScheduleDraft {
    const entry = this.require(owner, id, expectedRevision);
    if (entry.confirmed || entry.pending) throw new Error("Draft already confirmed");
    const time =
      typeof patch.when === "string" ? parseScheduleTime(patch.when, this.now()) : patch.when;
    if (time && (!Number.isFinite(time.dueAt) || time.dueAt <= this.now() || !time.timezone))
      throw new Error("Choose a future time");
    if (patch.target) entry.draft.target = structuredClone(patch.target);
    if (patch.text !== undefined) entry.draft.text = patch.text;
    if (time) {
      entry.draft.dueAt = time.dueAt;
      entry.draft.timezone = time.timezone;
    }
    entry.draft.revision++;
    return structuredClone(entry.draft);
  }
  bindPrompt(owner: ScheduleOwner, id: string, messageId: string, kind: "text" | "time"): void {
    const entry = this.require(owner, id);
    for (const [key, value] of entry.prompts) if (value === kind) entry.prompts.delete(key);
    entry.prompts.set(messageId, kind);
  }
  findPrompt(
    owner: ScheduleOwner,
    messageId: string,
  ): { draft: ScheduleDraft; kind: "text" | "time" } | undefined {
    for (const id of this.drafts.keys()) {
      const entry = this.entry(owner, id);
      const kind = entry?.prompts.get(messageId);
      if (entry && kind) return { draft: structuredClone(entry.draft), kind };
    }
    return undefined;
  }
  discard(owner: ScheduleOwner, id: string): boolean {
    const entry = this.entry(owner, id);
    if (!entry || entry.confirmed || entry.pending) return false;
    return this.drafts.delete(id);
  }
  async confirm(
    owner: ScheduleOwner,
    id: string,
    service: ScheduledMessageService,
    expectedRevision?: number,
  ): Promise<ScheduledMessageRecord> {
    const entry = this.require(owner, id, expectedRevision);
    if (entry.confirmed) return structuredClone(entry.confirmed);
    if (entry.pending) return entry.pending;
    const draft = entry.draft;
    if (!draft.text.trim()) throw new Error("Enter message text");
    if (!draft.dueAt || draft.dueAt <= this.now()) throw new Error("Choose a future time");
    entry.pending = service
      .create({
        owner,
        sessionName: draft.target.sessionName,
        target: draft.target,
        text: draft.text,
        when: { dueAt: draft.dueAt, timezone: draft.timezone ?? "UTC" },
        requestId: `draft:${draft.id}`,
      })
      .then((record) => {
        entry.confirmed = record;
        return record;
      })
      .finally(() => {
        delete entry.pending;
      });
    return entry.pending;
  }
  private require(owner: ScheduleOwner, id: string, revision?: number): StoredDraft {
    const entry = this.entry(owner, id);
    if (!entry) throw new Error("Draft expired or not found");
    if (revision !== undefined && entry.draft.revision !== revision)
      throw new Error("Stale draft action; open the current review");
    return entry;
  }
}
let singleton: ScheduleDrafts | undefined;
export function getScheduleDrafts(): ScheduleDrafts {
  singleton ??= new ScheduleDrafts();
  return singleton;
}
