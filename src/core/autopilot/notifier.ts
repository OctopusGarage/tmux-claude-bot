import { createLogger } from "../../shared/utils/logger.js";
import type { Messages } from "../i18n/index.js";

const log = createLogger("autopilot.notifier");

/** A proactive owner notice the supervisor emits. Adapters render it: most kinds
 * as localized text (renderNotice), `awaitHuman` as an interactive message in the
 * adapter (Phases 2–3). Structured so the adapter — which knows the channel and
 * its locale — owns presentation. */
export type AutopilotNotice =
  | { kind: "paused"; session: string; reason: string }
  | { kind: "stopped"; session: string; reason: string }
  | { kind: "usage"; session: string; pct: number }
  | { kind: "maxIter"; session: string }
  | { kind: "wallClock"; session: string }
  | { kind: "awaitHuman"; session: string; goalId: string }
  | { kind: "complete"; session: string; goalId: string }
  | { kind: "cycleComplete"; session: string; rounds: number }
  | { kind: "keepaliveDone"; session: string }
  | {
      kind: "goalAdvance";
      session: string;
      goalId: string;
      pos: number;
      total: number;
      round: number;
      rounds: number;
    };

export type OwnerPush = (notice: AutopilotNotice) => Promise<void>;

/** Default text rendering for a notice in a given locale. Adapters that want a
 * richer (interactive) rendering for a specific kind can special-case it and fall
 * back to this for the rest. */
export function renderNotice(n: AutopilotNotice, m: Messages): string {
  switch (n.kind) {
    case "paused":
      return m.autopilotNotifyPaused(n.session, n.reason);
    case "stopped":
      return m.autopilotNotifyStopped(n.session, n.reason);
    case "usage":
      return m.autopilotNotifyUsage(n.session, n.pct);
    case "maxIter":
      return m.autopilotNotifyMaxIter(n.session);
    case "wallClock":
      return m.autopilotNotifyWallClock(n.session);
    case "awaitHuman":
      return m.autopilotNotifyAwaitHuman(n.session);
    case "complete":
      return m.autopilotNotifyGoalComplete(n.session, n.goalId);
    case "cycleComplete":
      return m.autopilotNotifyCycleComplete(n.session, n.rounds);
    case "keepaliveDone":
      return m.autopilotNotifyKeepaliveDone(n.session);
    case "goalAdvance":
      return m.autopilotNotifyGoalAdvance(n.session, n.goalId, n.pos, n.total, n.round, n.rounds);
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
