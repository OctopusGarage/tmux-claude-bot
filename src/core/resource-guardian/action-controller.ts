import { sleep } from "../../shared/utils/sleep.js";
import { createExecProbe } from "../agents/agent-config-resolver.js";
import {
  type ActiveDelegatedTaskCancelResult,
  cancelActiveDelegatedTaskByRunId,
} from "../autopilot/delegated-task.js";
import type { HandlerDeps } from "../deps.js";
import {
  type LoopSupervisorWorkerLeaseState,
  readLoopSupervisorWorkerLeaseState,
} from "../loop/supervisor-pool.js";
import { reconcileTerminalSupervisorResources } from "../loop/supervisor-resource-reconciliation.js";
import {
  type LoopSupervisorWorkOrderRegistry,
  readLoopSupervisorWorkOrderRegistry,
} from "../loop/supervisor-state.js";
import { type ProcessIntrospector, selectIntrospector } from "../platform/introspector.js";
import { cleanupWorkerSessionRecords } from "../recovery/worker-session-cleanup.js";
import {
  DEFAULT_RESOURCE_ACTION_PRIORITY,
  executeResourceActions,
  planResourceActions,
  type ResourceActionCandidate,
  type ResourceActionPlan,
} from "./actions.js";
import {
  createBulkResourceProcessProbe,
  createSupervisorProcessOwnershipCollector,
} from "./ownership.js";
import type { DeepResourceProbe, PressureState, ResourceCircuitAdmission } from "./types.js";

export type ResourceActionController = {
  prepare(input: {
    now: number;
    pressure: PressureState;
    circuit: ResourceCircuitAdmission;
    incidentId: string | null;
  }): Promise<ResourceActionPlan>;
  execute(
    plan: ResourceActionPlan,
  ): Promise<{ outcome: "skipped" | "completed" | "failed"; reason: string }>;
};

export type ProductionResourceActionControllerOptions = {
  processProbe?: DeepResourceProbe;
  panePid?: ReturnType<typeof createExecProbe>["panePid"];
  introspector?: Pick<ProcessIntrospector, "cwdOf">;
  readRegistry?: (now: number) => LoopSupervisorWorkOrderRegistry;
  readLeaseState?: () => LoopSupervisorWorkerLeaseState;
  reconcile?: () => Promise<void>;
  cancel?: (runId: string) => Promise<ActiveDelegatedTaskCancelResult>;
  wait?: () => Promise<void>;
  signal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => Promise<void>;
  now?: () => number;
};

const RESOURCE_ACTION_GRACE_MS = 5_000;

/**
 * Compose Task 7's fresh ownership probe with the supervisor's existing durable
 * registry, lease, reconciliation, and cooperative-cancellation boundaries.
 */
export function createProductionResourceActionController(
  deps: HandlerDeps,
  options: ProductionResourceActionControllerOptions = {},
): ResourceActionController {
  const processProbe = options.processProbe ?? createBulkResourceProcessProbe({});
  const probe = options.panePid ?? createExecProbe().panePid;
  const introspector = options.introspector ?? selectIntrospector();
  const now = options.now ?? Date.now;
  const collectCandidates = async (): Promise<ResourceActionCandidate[]> => {
    const collectedAt = now();
    const registry = (options.readRegistry ?? readLoopSupervisorWorkOrderRegistry)(collectedAt);
    const leaseState = (options.readLeaseState ?? readLoopSupervisorWorkerLeaseState)();
    const sessions = new Set<string>();
    for (const { workOrder, state } of registry.records) {
      sessions.add(state.supervisorSession);
      if (workOrder.workerSession !== undefined) sessions.add(workOrder.workerSession);
    }
    for (const lease of leaseState.leases) sessions.add(lease.workerSession);
    const collector = createSupervisorProcessOwnershipCollector({
      processProbe,
      sessions: [...sessions],
      panePid: probe,
      readRegistry: () => registry,
      readLeaseState: () => leaseState,
      introspector,
      now,
    });
    const { ownership } = await collector.collect();
    const recordsByWorkOrder = new Map(
      registry.records.map((record) => [record.workOrder.id, record]),
    );
    return ownership.map((entry) => {
      const record = entry.workOrderId ? recordsByWorkOrder.get(entry.workOrderId) : undefined;
      const taskKind = record?.workOrder.task?.kind;
      return {
        ...entry,
        ...(taskKind === undefined ? {} : { taskKind }),
        cancellable:
          taskKind === "active-delegated-task" &&
          record !== undefined &&
          !["completed", "failed", "cancelled"].includes(record.state.status),
        // Loop WorkOrders do not yet persist priority; equal neutral priority preserves oldest-first.
        normalizedPriority: DEFAULT_RESOURCE_ACTION_PRIORITY,
      };
    });
  };
  return {
    async prepare() {
      const candidates = await collectCandidates();
      return planResourceActions({
        mode: "protect",
        pressure: "emergency",
        circuit: "background-closed",
        candidates,
      });
    },
    async execute(plan) {
      return executeResourceActions({
        plan,
        reconcile:
          options.reconcile ??
          (async () => {
            await reconcileTerminalSupervisorResources({
              now: now(),
              workerSessionExists: (session) => deps.bridge.hasSession(session),
              cleanupWorkerSession: async (session) => {
                await deps.bridge.killSession(session);
                cleanupWorkerSessionRecords(session);
              },
            });
          }),
        cancel:
          options.cancel ??
          ((runId) =>
            cancelActiveDelegatedTaskByRunId(deps, { runId, reason: "resource-pressure" })),
        wait: options.wait ?? (() => sleep(RESOURCE_ACTION_GRACE_MS)),
        collect: collectCandidates,
        signal:
          options.signal ??
          (async (pid, signal) => {
            process.kill(pid, signal);
          }),
      });
    },
  };
}
