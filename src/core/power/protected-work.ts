import { inspectAgentActivity } from "../agents/agent-activity.js";
import type { HandlerDeps } from "../deps.js";
import { readLoopSupervisorWorkerLeaseState } from "../loop/supervisor-pool.js";
import { listUnfinishedLoopSupervisorWorkOrders } from "../loop/supervisor-state.js";
import { getPathBySession } from "../projects/sessionPathMap.js";

export type ProtectedWorkSnapshot = { active: boolean; reasons: string[] };

export type ProtectedWorkSources = {
  queueHasWork(): boolean;
  unfinishedWorkOrderCount(): number;
  activeLeaseCount(): number;
  busyAgentSessions(): Promise<string[]>;
};

export async function readProtectedWork(
  sources: ProtectedWorkSources,
): Promise<ProtectedWorkSnapshot> {
  if (sources.queueHasWork()) return { active: true, reasons: ["message-queue"] };

  const unfinishedWorkOrders = sources.unfinishedWorkOrderCount();
  const activeLeases = sources.activeLeaseCount();
  const durableReasons = [
    ...(unfinishedWorkOrders > 0 ? [`work-orders:${unfinishedWorkOrders}`] : []),
    ...(activeLeases > 0 ? [`worker-leases:${activeLeases}`] : []),
  ];
  if (durableReasons.length > 0) return { active: true, reasons: durableReasons };

  const busySessions = await sources.busyAgentSessions();
  const reasons = busySessions.map((session) => `agent:${session}`);
  return { active: reasons.length > 0, reasons };
}

export function createProtectedWorkProbe(deps: HandlerDeps): () => Promise<ProtectedWorkSnapshot> {
  return () =>
    readProtectedWork({
      queueHasWork: () => deps.queue.hasPendingOrRunning(),
      unfinishedWorkOrderCount: () => listUnfinishedLoopSupervisorWorkOrders().length,
      activeLeaseCount: () =>
        readLoopSupervisorWorkerLeaseState().leases.filter((lease) => lease.status === "active")
          .length,
      busyAgentSessions: async () => {
        const sessions = await deps.bridge.listProjectSessions();
        const activity = await Promise.all(
          sessions.map(async (session) => ({
            session,
            status: await inspectAgentActivity(deps, session, getPathBySession(session)),
          })),
        );
        return activity.filter(({ status }) => status.agentBusy).map(({ session }) => session);
      },
    });
}
