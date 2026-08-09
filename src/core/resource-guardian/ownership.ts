import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResolverProbe } from "../agents/agent-config-resolver.js";
import { isLoopSupervisorWorkerLeaseExpired } from "../loop/supervisor-pool.js";
import type { ProcessIntrospector } from "../platform/introspector.js";
import type {
  DeepResourceProbe,
  DeepResourceSnapshot,
  ProcessOwnership,
  ResourceProcess,
} from "./types.js";

export type ProcessInstance = Pick<ResourceProcess, "pid" | "startedAt"> & { pgid?: number };

/** A tmux pane root linked to a durable automation session. */
export type PaneEvidence = { session: string; pane: ProcessInstance };

/** A normalized WorkOrder state; status preserves the supervisor registry vocabulary. */
export type WorkOrderEvidence = {
  id: string;
  workerSession: string;
  supervisorSession: string;
  status:
    | "dispatching"
    | "queued"
    | "in-flight"
    | "needs-revision"
    | "completed"
    | "failed"
    | "cancelled";
};

/** A normalized worker lease; status preserves the supervisor-pool vocabulary. */
export type LeaseEvidence = {
  id: string;
  workOrderId: string;
  supervisorSession: string;
  status: "active" | "retained";
  retainUntil?: number;
};

/** Exact process identity written when the bot launches an automation process. */
export type LaunchEvidence = {
  process: ProcessInstance;
  session: string;
  workOrderId: string;
};

export type ProcessOwnershipSnapshot = {
  processes: readonly ResourceProcess[];
  panes?: readonly PaneEvidence[];
  workOrders?: readonly WorkOrderEvidence[];
  leases?: readonly LeaseEvidence[];
  launches?: readonly LaunchEvidence[];
  /** Pane ids observed to change around the process snapshot cannot prove ownership. */
  unstablePanePids?: readonly number[];
  now: number;
};

const TERMINAL_WORK_ORDER_STATUSES = new Set<WorkOrderEvidence["status"]>([
  "completed",
  "failed",
  "cancelled",
]);
const AUTOMATION_COMMAND = /(?:^|[\s/])(claude|codex|pytest|node|tmux)(?:[\s-]|$)/i;

export function sameProcessInstance(expected: ProcessInstance, current: ProcessInstance): boolean {
  return (
    expected.pid === current.pid &&
    expected.startedAt === current.startedAt &&
    (expected.pgid === undefined || current.pgid === undefined || expected.pgid === current.pgid)
  );
}

function isAutomationLooking(process: ResourceProcess): boolean {
  return AUTOMATION_COMMAND.test(process.command);
}

function ownership(
  process: ResourceProcess,
  classification: ProcessOwnership["classification"],
  strong: boolean,
  details: Omit<ProcessOwnership, "process" | "classification" | "strong"> = { evidence: [] },
): ProcessOwnership {
  return { process, classification, strong, ...details };
}

/**
 * Resolve process attribution from durable state and exact process ancestry.
 * Commands, paths, and cwd are intentionally never accepted as strong evidence.
 */
export function createProcessOwnershipResolver(snapshot: ProcessOwnershipSnapshot): {
  resolve(pid: number): ProcessOwnership | null;
  resolveAll(): ProcessOwnership[];
} {
  const byPid = new Map(snapshot.processes.map((process) => [process.pid, process]));
  const panes = snapshot.panes ?? [];
  const workOrders = snapshot.workOrders ?? [];
  const leases = snapshot.leases ?? [];
  const launches = snapshot.launches ?? [];

  const ancestorsOf = (
    process: ResourceProcess,
  ): { ancestors: ResourceProcess[]; valid: boolean } => {
    const ancestors: ResourceProcess[] = [];
    const seen = new Set<number>();
    let current: ResourceProcess | undefined = process;
    while (current !== undefined) {
      if (current.ppid === current.pid || seen.has(current.pid)) return { ancestors, valid: false };
      seen.add(current.pid);
      ancestors.push(current);
      current = byPid.get(current.ppid);
    }
    return { ancestors, valid: true };
  };

  const resolve = (pid: number): ProcessOwnership | null => {
    const process = byPid.get(pid);
    if (process === undefined) return null;
    const ancestry = ancestorsOf(process);
    if (!ancestry.valid)
      return ownership(process, "unknown", false, { evidence: ["invalid-process-ancestry"] });
    const ancestors = ancestry.ancestors;
    if (
      (snapshot.unstablePanePids ?? []).some((pid) => ancestors.some((entry) => entry.pid === pid))
    ) {
      return ownership(process, "unknown", false, { evidence: ["unstable-pane-pid"] });
    }
    const paneCandidates = panes.filter((pane) =>
      ancestors.some((candidate) => candidate.pid === pane.pane.pid),
    );
    const launchCandidates = launches.filter((launch) =>
      ancestors.some((candidate) => candidate.pid === launch.process.pid),
    );
    const exactPanes = paneCandidates.filter((pane) =>
      ancestors.some((candidate) => sameProcessInstance(pane.pane, candidate)),
    );
    const exactLaunches = launchCandidates.filter((launch) =>
      ancestors.some((candidate) => sameProcessInstance(launch.process, candidate)),
    );

    // A pid match with a changed start time is a possible reused pid, not proof.
    if (
      paneCandidates.length !== exactPanes.length ||
      launchCandidates.length !== exactLaunches.length
    ) {
      return ownership(process, "unknown", false, { evidence: ["process-instance-mismatch"] });
    }

    if (exactPanes.length === 0 && exactLaunches.length === 0) {
      return ownership(process, isAutomationLooking(process) ? "unknown" : "external", false, {
        evidence: isAutomationLooking(process) ? ["automation-looking-command"] : [],
      });
    }
    const evidenceWorkOrderIds = new Set(exactLaunches.map((launch) => launch.workOrderId));
    const paneWorkOrders = workOrders.filter((workOrder) =>
      exactPanes.some(
        (pane) =>
          pane.session === workOrder.workerSession || pane.session === workOrder.supervisorSession,
      ),
    );
    const launchWorkOrders = workOrders.filter((workOrder) =>
      exactLaunches.some(
        (launch) =>
          launch.workOrderId === workOrder.id &&
          (launch.session === workOrder.workerSession ||
            launch.session === workOrder.supervisorSession),
      ),
    );
    const supervisorPaneWorkOrders = paneWorkOrders.filter((workOrder) =>
      exactPanes.some(
        (pane) =>
          pane.session === workOrder.supervisorSession && pane.session !== workOrder.workerSession,
      ),
    );
    const supervisorReservations = leases.filter((lease) =>
      supervisorPaneWorkOrders.some(
        (workOrder) =>
          workOrder.id === lease.workOrderId &&
          workOrder.supervisorSession === lease.supervisorSession,
      ),
    );
    const narrowedPaneWorkOrders =
      supervisorReservations.length === 1
        ? paneWorkOrders.filter(
            (workOrder) => workOrder.id === supervisorReservations[0]?.workOrderId,
          )
        : paneWorkOrders;
    const matchingWorkOrders =
      exactPanes.length > 0 && exactLaunches.length > 0
        ? narrowedPaneWorkOrders.filter((workOrder) => launchWorkOrders.includes(workOrder))
        : exactPanes.length > 0
          ? narrowedPaneWorkOrders
          : launchWorkOrders;
    const workOrder = matchingWorkOrders.length === 1 ? matchingWorkOrders[0] : undefined;

    if (evidenceWorkOrderIds.size > 1 || matchingWorkOrders.length > 1) {
      return ownership(process, "unknown", false, { evidence: ["contradictory-work-order"] });
    }
    if (workOrder === undefined) {
      return ownership(process, "unknown", false, { evidence: ["missing-durable-work-order"] });
    }

    const matchingLeases = leases.filter((lease) => lease.workOrderId === workOrder.id);
    if (
      matchingLeases.length > 1 ||
      (matchingLeases[0] !== undefined &&
        matchingLeases[0].supervisorSession !== workOrder.supervisorSession)
    ) {
      return ownership(process, "unknown", false, { evidence: ["contradictory-lease"] });
    }
    const lease = matchingLeases[0];
    const isTerminal = TERMINAL_WORK_ORDER_STATUSES.has(workOrder.status);
    const isExpired =
      lease !== undefined && isLoopSupervisorWorkerLeaseExpired(lease, snapshot.now);
    const hasPanePath = exactPanes.length > 0;
    const hasLaunchPath = exactLaunches.length > 0;
    const session = exactPanes[0]?.session ?? exactLaunches[0]?.session;

    if (!isTerminal && isExpired && hasPanePath) {
      return ownership(process, "bot-stale", true, {
        ...(session === undefined ? {} : { session }),
        workOrderId: workOrder.id,
        leaseId: lease.id,
        evidence: ["exact-pane-ancestry", "nonterminal-work-order", "expired-lease"],
      });
    }
    if (isTerminal && ((hasPanePath && lease !== undefined) || hasLaunchPath)) {
      return ownership(process, "bot-terminal", true, {
        ...(session === undefined ? {} : { session }),
        workOrderId: workOrder.id,
        ...(lease === undefined ? {} : { leaseId: lease.id }),
        evidence: [
          hasPanePath && lease !== undefined ? "exact-pane-ancestry" : "exact-launch-ancestry",
          "terminal-work-order",
        ],
      });
    }
    if (!isTerminal && ((hasPanePath && lease?.status === "active") || hasLaunchPath)) {
      return ownership(process, "bot-active", true, {
        ...(session === undefined ? {} : { session }),
        workOrderId: workOrder.id,
        ...(lease === undefined ? {} : { leaseId: lease.id }),
        evidence: [
          hasPanePath ? "exact-pane-ancestry" : "exact-launch-ancestry",
          "nonterminal-work-order",
          ...(lease?.status === "active" ? ["active-lease"] : []),
        ],
      });
    }
    return ownership(process, "unknown", false, {
      ...(session === undefined ? {} : { session }),
      workOrderId: workOrder.id,
      ...(lease === undefined ? {} : { leaseId: lease.id }),
      evidence: ["incomplete-durable-evidence"],
    });
  };

  return {
    resolve,
    resolveAll: () =>
      snapshot.processes
        .map((process) => resolve(process.pid))
        .filter((value): value is ProcessOwnership => value !== null),
  };
}

export type BulkProcessExec = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

/** Parse the one bulk `ps` layout used by the deep resource sampler. */
export function parseResourceProcessPs(stdout: string): ResourceProcess[] {
  const rows: ResourceProcess[] = [];
  for (const line of stdout.split("\n")) {
    const match = line
      .trim()
      .match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+?\d{4})\s+(-?(?:\d+(?:\.\d*)?|\.\d+))\s+(\d+)\s*(.*)$/);
    if (
      match?.[1] === undefined ||
      match[2] === undefined ||
      match[3] === undefined ||
      match[4] === undefined ||
      match[5] === undefined ||
      match[6] === undefined
    )
      continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    const cpuPct = Number(match[5]);
    const rssKb = Number(match[6]);
    const parsedStart = Date.parse(match[4]);
    if (
      [pid, ppid, pgid, cpuPct, rssKb].some((value) => !Number.isFinite(value)) ||
      Number.isNaN(parsedStart)
    )
      continue;
    rows.push({
      pid,
      ppid,
      pgid,
      startedAt: new Date(parsedStart).toISOString(),
      cpuPct,
      rssKb,
      command: match[7] ?? "",
    });
  }
  return rows;
}

export function createBulkResourceProcessProbe(input: {
  exec?: BulkProcessExec;
  now?: () => number;
  thermal?: DeepResourceSnapshot["thermal"];
}): DeepResourceProbe {
  const exec = input.exec ?? (promisify(execFile) as BulkProcessExec);
  const now = input.now ?? Date.now;
  return async () => {
    const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,%cpu=,rss=,command="], {
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    const processes = parseResourceProcessPs(stdout);
    if (stdout.trim() !== "" && processes.length === 0) {
      throw new Error("unable to parse process snapshot");
    }
    return {
      capturedAt: now(),
      thermal: input.thermal ?? "unknown",
      processes,
    };
  };
}

type PanePids = (session: string) => Promise<readonly number[]>;

function samePids(before: readonly number[], after: readonly number[]): boolean {
  return before.length === after.length && before.every((pid, index) => pid === after[index]);
}

async function mapWithConcurrency<T>(
  entries: readonly T[],
  limit: number,
  task: (entry: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), entries.length) }, async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      if (entry !== undefined) await task(entry);
    }
  });
  await Promise.all(workers);
}

export function createProductionProcessOwnershipCollector(input: {
  processProbe: DeepResourceProbe;
  sessions: readonly string[];
  panePid: ResolverProbe["panePid"];
  panePids?: PanePids;
  readWorkOrders: () => readonly WorkOrderEvidence[];
  readLeases: () => readonly LeaseEvidence[];
  readLaunches?: () => readonly LaunchEvidence[];
  introspector: Pick<ProcessIntrospector, "cwdOf">;
  now?: () => number;
  highCpuPct?: number;
  cwdLimit?: number;
  cwdConcurrency?: number;
}): { collect(): Promise<{ snapshot: DeepResourceSnapshot; ownership: ProcessOwnership[] }> } {
  const now = input.now ?? Date.now;
  const highCpuPct = input.highCpuPct ?? 25;
  const cwdLimit = input.cwdLimit ?? 16;
  const cwdConcurrency = input.cwdConcurrency ?? 2;
  const panePids: PanePids =
    input.panePids ??
    (async (session) => {
      const pid = await input.panePid(session);
      return pid === null ? [] : [pid];
    });
  return {
    async collect() {
      const beforePanes = await Promise.all(
        input.sessions.map(async (session) => ({ session, pids: await panePids(session) })),
      );
      const snapshot = await input.processProbe();
      const byPid = new Map(snapshot.processes.map((process) => [process.pid, process]));
      const afterPanes = await Promise.all(
        input.sessions.map(async (session) => ({ session, pids: await panePids(session) })),
      );
      const afterBySession = new Map(afterPanes.map((entry) => [entry.session, entry.pids]));
      const unstablePanePids = beforePanes.flatMap(({ session, pids }) => {
        const after = afterBySession.get(session) ?? [];
        return samePids(pids, after) ? [] : [...pids, ...after];
      });
      const panes: PaneEvidence[] = beforePanes.flatMap(({ session, pids }) => {
        const after = afterBySession.get(session) ?? [];
        if (!samePids(pids, after)) return [];
        return pids.flatMap((pid) => {
          const pane = byPid.get(pid);
          return pane === undefined ? [] : [{ session, pane }];
        });
      });
      const resolver = createProcessOwnershipResolver({
        processes: snapshot.processes,
        panes,
        workOrders: input.readWorkOrders(),
        leases: input.readLeases(),
        ...(input.readLaunches === undefined ? {} : { launches: input.readLaunches() }),
        unstablePanePids,
        now: now(),
      });
      const ownership = resolver.resolveAll();
      const cwdByPid = new Map<number, string | null>();
      // Platform cwdOf may use one lsof call per shortlisted candidate; never scan the full table.
      const cwdShortlist = ownership
        .filter(
          (entry) =>
            entry.strong ||
            (entry.classification === "unknown" &&
              (isAutomationLooking(entry.process) || entry.process.cpuPct >= highCpuPct)),
        )
        .sort((a, b) => b.process.cpuPct - a.process.cpuPct)
        .slice(0, cwdLimit);
      await mapWithConcurrency(cwdShortlist, cwdConcurrency, async (entry) => {
        const cwd = await input.introspector.cwdOf(entry.process.pid).catch(() => null);
        cwdByPid.set(entry.process.pid, cwd);
      });
      const processes = snapshot.processes.map((process) => {
        const cwd = cwdByPid.get(process.pid);
        return cwd === null || cwd === undefined ? process : { ...process, cwd };
      });
      const processesByPid = new Map(processes.map((process) => [process.pid, process]));
      return {
        snapshot: { ...snapshot, processes },
        ownership: ownership.map((entry) => ({
          ...entry,
          process: processesByPid.get(entry.process.pid) ?? entry.process,
        })),
      };
    },
  };
}

/** The small read-only projection needed from the durable supervisor registry. */
export type SupervisorRegistryEvidence = {
  records: readonly {
    workOrder: { id: string; workerSession?: string };
    state: { supervisorSession: string; status: WorkOrderEvidence["status"] };
  }[];
};

/** The small read-only projection needed from the durable supervisor-pool state. */
export type SupervisorLeaseStateEvidence = {
  leases: readonly {
    workOrderId: string;
    workerSession: string;
    status: LeaseEvidence["status"];
    retainUntil?: number;
  }[];
};

export function normalizeSupervisorWorkOrderEvidence(
  records: SupervisorRegistryEvidence["records"],
): WorkOrderEvidence[] {
  return records.map(({ workOrder, state }) => ({
    id: workOrder.id,
    workerSession: workOrder.workerSession ?? state.supervisorSession,
    supervisorSession: state.supervisorSession,
    status: state.status,
  }));
}

export function normalizeSupervisorLeaseEvidence(
  leases: SupervisorLeaseStateEvidence["leases"],
): LeaseEvidence[] {
  return leases.map((lease) => ({
    id: `${lease.workOrderId}:${lease.workerSession}`,
    workOrderId: lease.workOrderId,
    supervisorSession: lease.workerSession,
    status: lease.status,
    ...(lease.retainUntil === undefined ? {} : { retainUntil: lease.retainUntil }),
  }));
}

/**
 * Adapter boundary for Task 7 wiring. Callers supply the existing ResolverProbe
 * pane lookup and the one-per-snapshot supervisor registry/pool readers; Task 8
 * can compose it into service lifecycle handling without granting action rights.
 */
export function createSupervisorProcessOwnershipCollector(input: {
  processProbe: DeepResourceProbe;
  sessions: readonly string[];
  panePid: ResolverProbe["panePid"];
  panePids?: PanePids;
  readRegistry: () => SupervisorRegistryEvidence;
  readLeaseState: () => SupervisorLeaseStateEvidence;
  readLaunches?: () => readonly LaunchEvidence[];
  introspector: Pick<ProcessIntrospector, "cwdOf">;
  now?: () => number;
  highCpuPct?: number;
  cwdLimit?: number;
  cwdConcurrency?: number;
}): ReturnType<typeof createProductionProcessOwnershipCollector> {
  return createProductionProcessOwnershipCollector({
    processProbe: input.processProbe,
    sessions: input.sessions,
    panePid: input.panePid,
    ...(input.panePids === undefined ? {} : { panePids: input.panePids }),
    readWorkOrders: () => normalizeSupervisorWorkOrderEvidence(input.readRegistry().records),
    readLeases: () => normalizeSupervisorLeaseEvidence(input.readLeaseState().leases),
    ...(input.readLaunches === undefined ? {} : { readLaunches: input.readLaunches }),
    introspector: input.introspector,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.highCpuPct === undefined ? {} : { highCpuPct: input.highCpuPct }),
    ...(input.cwdLimit === undefined ? {} : { cwdLimit: input.cwdLimit }),
    ...(input.cwdConcurrency === undefined ? {} : { cwdConcurrency: input.cwdConcurrency }),
  });
}
