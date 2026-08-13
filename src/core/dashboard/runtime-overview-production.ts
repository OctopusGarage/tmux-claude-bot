import { appStateDir } from "../../shared/state-dir.js";
import { readAiToolReadiness } from "../ai-tools/install-contract.js";
import { AgentCapacityStore } from "../automation/capacity-store.js";
import { AutomationOccurrenceStore } from "../automation/occurrence-window.js";
import { readAutomationStatuses } from "../config/automation-command.js";
import type { HandlerDeps } from "../deps.js";
import { RepositoryReviewQueue } from "../loop/repository-review-queue.js";
import { readLoopSupervisorWorkOrderRegistry } from "../loop/supervisor-state.js";
import { type PowerStatusView, readPowerStatus } from "../platform/power-command.js";
import { createPowerScheduleProbe } from "../platform/power-schedule.js";
import { readMacPowerSource } from "../platform/power-source.js";
import { operatorHomeDir } from "../projects/operator-home.js";
import { createResourceGuardianStore } from "../resource-guardian/store.js";
import { discoverRuntimeGuardianFindings } from "../runtime-guardian/inspector.js";
import { DailyTaskAuditStore } from "../tasks/daily-audit-service.js";
import { DailyTaskLedger, summarizeTaskWindow } from "../tasks/task-ledger.js";
import type { RuntimeOverviewReaders, WorkOrderOverviewRead } from "./runtime-overview-reader.js";

const POWER_CACHE_MS = 30_000;
const DOMAIN_CACHE_MS = 30_000;
let powerCache: { key: string; readAt: number; value: PowerStatusView } | null = null;
let workOrderCache: { key: string; readAt: number; value: WorkOrderOverviewRead } | null = null;
let dailyAuditCache: {
  key: string;
  readAt: number;
  value: Awaited<ReturnType<RuntimeOverviewReaders["dailyAudit"]>>;
} | null = null;
let runtimeGuardianCache: {
  key: string;
  readAt: number;
  value: Awaited<ReturnType<RuntimeOverviewReaders["runtimeGuardian"]>>;
} | null = null;

function cachedDomain<T>(
  cache: { key: string; readAt: number; value: T } | null,
  key: string,
  now: number,
  read: () => T,
): { entry: { key: string; readAt: number; value: T }; value: T } {
  if (
    cache !== null &&
    cache.key === key &&
    now >= cache.readAt &&
    now - cache.readAt < DOMAIN_CACHE_MS
  ) {
    return { entry: cache, value: cache.value };
  }
  const value = read();
  return { entry: { key, readAt: now, value }, value };
}

function readCachedPower(deps: HandlerDeps, now: number): PowerStatusView {
  const key = JSON.stringify(deps.config.hostPower);
  if (
    powerCache !== null &&
    powerCache.key === key &&
    now >= powerCache.readAt &&
    now - powerCache.readAt < POWER_CACHE_MS
  ) {
    return powerCache.value;
  }
  const value = readPowerStatus(
    deps.config.hostPower,
    now,
    createPowerScheduleProbe(),
    readMacPowerSource(),
  );
  powerCache = { key, readAt: now, value };
  return value;
}

export function createRuntimeOverviewReaders(input: {
  deps: HandlerDeps;
  now: number;
  operatorSessionRunning: boolean;
  service?: {
    uptimeMs: number | null;
    adapters: { telegram: boolean; lark: boolean };
  };
}): RuntimeOverviewReaders {
  const { deps, now } = input;
  return {
    automation: readAutomationStatuses,
    workOrders: () => {
      const read = cachedDomain(workOrderCache, appStateDir(), now, () => {
        const registry = readLoopSupervisorWorkOrderRegistry(now);
        const mapRecord = (record: (typeof registry.records)[number]) => ({
          id: record.workOrder.id,
          projectId: record.workOrder.projectId,
          projectName: record.workOrder.projectName,
          taskKind: record.workOrder.task?.kind ?? "loop",
          status: record.state.status,
          scheduledAt: record.workOrder.scheduledAt,
          updatedAt: record.state.updatedAt,
        });
        return {
          unfinished: registry.unfinished.map(mapRecord),
          terminal: registry.terminal.map(mapRecord),
          abandoned: registry.abandoned.map(mapRecord),
          staleDispatching: registry.staleDispatching.map(mapRecord),
        };
      });
      workOrderCache = read.entry;
      return read.value;
    },
    repositoryReviews: () =>
      new RepositoryReviewQueue()
        .list({ all: true })
        .filter(
          (item) =>
            item.status === "retry-wait" ||
            item.status === "manual-review" ||
            item.status === "dead-letter",
        )
        .map((item) => ({
          id: item.id,
          repositoryId: item.repositoryId,
          status: item.status as "retry-wait" | "manual-review" | "dead-letter",
          updatedAt: item.updatedAt,
          nextAttemptAt: item.nextAttemptAt,
          retryEpoch: item.retryEpoch ?? 0,
        })),
    dailyAudit: () => {
      const read = cachedDomain(dailyAuditCache, appStateDir(), now, () => {
        const window = {
          start: now - 7 * 24 * 60 * 60 * 1_000,
          end: now + 1,
          label: "recent 7 days",
        };
        const records = new DailyTaskLedger().listForWindow(window);
        const summary = summarizeTaskWindow({ records, now, window });
        const outcomes = summary.items
          .filter(
            (record) =>
              !["running", "expected"].includes(record.status) &&
              !["loop-engineering", "autopilot-delegate"].includes(record.source),
          )
          .map((record) => ({
            id: `ledger:${record.taskId}`,
            domain: record.source,
            label: record.name,
            status:
              record.status === "success"
                ? ("passed" as const)
                : record.status === "skipped"
                  ? ("cancelled" as const)
                  : ("failed" as const),
            endedAt: record.endedAt ?? record.updatedAt,
          }));
        return {
          enabled: deps.config.taskAudit.enabled && deps.config.taskAudit.tickMs > 0,
          ...(() => {
            const lastFiredAt = new DailyTaskAuditStore().getLastFired();
            return lastFiredAt === undefined ? {} : { lastFiredAt };
          })(),
          summary: {
            active: summary.items.filter(
              (item) => item.source === "daily-audit" && item.status === "running",
            ).length,
            failed: summary.counts.failed + summary.counts.missing + summary.counts.runningTimeout,
            attention: summary.items.filter(
              (item) =>
                ["failed", "missing", "running-timeout"].includes(item.status) &&
                !["fixed", "not-needed", "superseded", "not-reproducible"].includes(
                  item.repairStatus ?? "pending",
                ),
            ).length,
            repairPending: summary.items.filter((item) => item.repairStatus === "pending").length,
          },
          outcomes,
        };
      });
      dailyAuditCache = read.entry;
      return read.value;
    },
    runtimeGuardian: () => {
      const key = `${appStateDir()}:${deps.config.runtimeGuardian.enabled}:${deps.config.runtimeGuardian.tickMs}:${deps.config.runtimeGuardian.lookbackMs}:${deps.config.runtimeGuardian.repoPath}`;
      const read = cachedDomain(runtimeGuardianCache, key, now, () => ({
        enabled: deps.config.runtimeGuardian.enabled && deps.config.runtimeGuardian.tickMs > 0,
        findings:
          !deps.config.runtimeGuardian.enabled || deps.config.runtimeGuardian.tickMs === 0
            ? []
            : discoverRuntimeGuardianFindings({
                now,
                lookbackMs: deps.config.runtimeGuardian.lookbackMs,
                ...(deps.config.runtimeGuardian.repoPath.trim().length > 0
                  ? { repoPath: deps.config.runtimeGuardian.repoPath }
                  : {}),
              }).map((finding) => ({
                id: `${finding.kind}:${finding.runId}`,
                projectId: finding.projectId,
                kind: finding.kind,
                severity: finding.severity,
                observedAt: now,
              })),
      }));
      runtimeGuardianCache = read.entry;
      return read.value;
    },
    resourceGuardian: () => {
      if (!deps.config.resourceGuardian.enabled || deps.config.resourceGuardian.tickMs === 0) {
        return {
          enabled: false,
          mode: deps.config.resourceGuardian.mode,
          profile: deps.config.resourceGuardian.profile,
          pressure: "healthy",
          circuit: "open",
          changedAt: now,
          degraded: false,
          samplingDegraded: false,
        };
      }
      const current = createResourceGuardianStore({
        stateDir: appStateDir(),
      }).readCurrentReadOnly();
      return {
        enabled: current.view.enabled,
        mode: current.view.mode,
        profile: current.view.profile,
        pressure: current.view.pressure,
        circuit: current.view.circuit,
        changedAt: current.circuit.changedAt,
        degraded: current.degraded,
        samplingDegraded: current.view.sampling.degraded,
      };
    },
    agentCapacity: () => {
      const agent = deps.config.loopEngineering.supervisor.agent;
      const capacity = new AgentCapacityStore().read(agent, now);
      const planned = new AutomationOccurrenceStore()
        .list()
        .filter(
          (occurrence) => occurrence.status === "planned" || occurrence.status === "admitted",
        );
      return {
        enabled: deps.config.loopEngineering.supervisor.enabled,
        agent,
        authentication: capacity.authentication,
        state: capacity.state,
        observedAt: capacity.observedAt,
        retryAt: capacity.resetAt ?? capacity.nextProbeAt,
        activeAutonomousLeases: capacity.activeAutonomousLeases,
        plannedOccurrences: planned.length,
        nextOccurrenceAt:
          planned.length === 0
            ? null
            : Math.min(...planned.map((occurrence) => occurrence.notBefore)),
        ownerLastActivityAt: deps.ownerActivity.lastObservedAt(),
      };
    },
    power: () => {
      const status = readCachedPower(deps, now);
      return {
        mode: status.mode,
        phase: status.phase,
        powerSource: status.powerSource,
        scheduleStatus: status.schedule.status,
        degraded: status.degradedReason !== null,
        ...(input.service === undefined ? {} : { service: input.service }),
      };
    },
    operator: () => {
      const readiness = readAiToolReadiness(operatorHomeDir(deps.config));
      return {
        session: {
          state: deps.config.homeOperator.enabled
            ? input.operatorSessionRunning
              ? "ready"
              : "attention"
            : "disabled",
        },
        skills: readiness.skills,
        mcpProfiles: readiness.mcpProfiles,
        promptLibrary: {
          state: deps.config.promptMcp.command.trim().length > 0 ? "configured" : "disabled",
        },
        // Project-declared MCPs are intentionally excluded from the global snapshot:
        // their trusted root is not part of the Dashboard request. Dedicated AI-tool
        // diagnostics may add an explicit project-root reader later without depending on cwd.
        optionalProjectMcpCount: null,
      };
    },
  };
}
