import { appStateDir } from "../../shared/state-dir.js";
import { readAiToolReadiness, readOptionalProjectMcpCount } from "../ai-tools/install-contract.js";
import { readAutomationStatuses } from "../config/automation-command.js";
import type { HandlerDeps } from "../deps.js";
import { readLoopSupervisorWorkOrderRegistry } from "../loop/supervisor-state.js";
import { type PowerStatusView, readPowerStatus } from "../platform/power-command.js";
import { createPowerScheduleProbe } from "../platform/power-schedule.js";
import { readMacPowerSource } from "../platform/power-source.js";
import { operatorHomeDir } from "../projects/operator-home.js";
import { createResourceGuardianStore } from "../resource-guardian/store.js";
import { discoverRuntimeGuardianFindings } from "../runtime-guardian/inspector.js";
import { SchedulerStore } from "../scheduler/scheduler-store.js";
import { DailyTaskAuditStore } from "../tasks/daily-audit-service.js";
import type { RuntimeOverviewReaders } from "./runtime-overview-reader.js";

const POWER_CACHE_MS = 30_000;
let powerCache: { key: string; readAt: number; value: PowerStatusView } | null = null;

function readCachedPower(deps: HandlerDeps, now: number): PowerStatusView {
  const key = JSON.stringify(deps.config.hostPower);
  if (powerCache !== null && powerCache.key === key && now - powerCache.readAt < POWER_CACHE_MS) {
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
  projectRoot?: string;
}): RuntimeOverviewReaders {
  const { deps, now } = input;
  return {
    automation: readAutomationStatuses,
    workOrders: () => {
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
    },
    batch: () => {
      const active = new SchedulerStore().getActiveRun();
      return {
        enabled: deps.config.scheduler.tickMs > 0,
        ...(active === undefined
          ? {}
          : {
              active: {
                id: active.runId,
                label: `Batch ${active.planId}`,
                status: active.status,
                startedAt: active.startedAt,
              },
            }),
      };
    },
    dailyAudit: () => ({
      enabled: deps.config.taskAudit.enabled && deps.config.taskAudit.tickMs > 0,
      ...(() => {
        const lastFiredAt = new DailyTaskAuditStore().getLastFired();
        return lastFiredAt === undefined ? {} : { lastFiredAt };
      })(),
    }),
    runtimeGuardian: () => ({
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
    }),
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
    power: () => {
      const status = readCachedPower(deps, now);
      return {
        mode: status.mode,
        phase: status.phase,
        powerSource: status.powerSource,
        scheduleStatus: status.schedule.status,
        degraded: status.degradedReason !== null,
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
          state: deps.config.promptMcp.command.trim().length > 0 ? "ready" : "disabled",
        },
        optionalProjectMcpCount: readOptionalProjectMcpCount(input.projectRoot ?? process.cwd()),
      };
    },
  };
}
