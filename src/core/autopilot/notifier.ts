import { createLogger } from "../../shared/utils/logger.js";
import type { Messages } from "../i18n/index.js";

const log = createLogger("autopilot.notifier");

/** A proactive owner notice emitted by the batch/supervisor infrastructure. */
export type AutopilotNotice =
  | { kind: "batchRunStarted"; runId: string; planId: string; tasks: number }
  | { kind: "batchPoolPaused"; runId: string; agent: string; resumeAt: number }
  | { kind: "batchRunComplete"; runId: string; summary: string };

export type OwnerPush = (notice: AutopilotNotice) => Promise<void>;

/** Default text rendering for a notice in a given locale. */
export function renderNotice(n: AutopilotNotice, m: Messages): string {
  switch (n.kind) {
    case "batchRunStarted":
      return m.batchRunStarted(n.planId, n.tasks);
    case "batchPoolPaused":
      return m.batchPoolPaused(n.agent, new Date(n.resumeAt).toLocaleTimeString());
    case "batchRunComplete":
      return m.batchRunComplete(n.summary);
  }
}

export class NotifierRegistry {
  private readonly pushers: OwnerPush[] = [];

  register(push: OwnerPush): void {
    this.pushers.push(push);
  }

  async broadcast(notice: AutopilotNotice): Promise<void> {
    await Promise.all(
      this.pushers.map((p) => p(notice).catch((err) => log.warn("owner push failed", { err }))),
    );
  }
}
