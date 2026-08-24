import type { AgentCapacityView } from "../automation/capacity.js";
import {
  type ActiveWorkItem,
  type AttentionItem,
  type AutomationFamilyView,
  buildRuntimeOverview,
  type OperatorInterfaceView,
  type RecentOutcome,
  type RuntimeDomainView,
  type RuntimeOverview,
  type RuntimeOverviewOptions,
} from "./runtime-overview.js";

export type RuntimeOverviewSession = {
  session: string;
  label: string;
  busy: boolean;
  running: boolean;
  operator?: boolean;
  taskStartedAt?: number;
};

export type OverviewWorkOrder = {
  id: string;
  projectId: string;
  projectName: string;
  taskKind: string;
  status: string;
  scheduledAt: number;
  updatedAt: number;
  repairStatus?: string;
};

export type WorkOrderOverviewRead = {
  unfinished: OverviewWorkOrder[];
  terminal: OverviewWorkOrder[];
  abandoned: OverviewWorkOrder[];
  staleDispatching: OverviewWorkOrder[];
};

export type RepositoryReviewOverview = {
  id: string;
  repositoryId: string;
  status: "retry-wait" | "manual-review" | "dead-letter";
  updatedAt: number;
  nextAttemptAt: number;
  retryEpoch: number;
};

export type AgentCapacityOverview = {
  enabled: boolean;
  agent: AgentCapacityView["agent"];
  authentication: AgentCapacityView["authentication"];
  state: AgentCapacityView["state"];
  observedAt: number;
  retryAt: number | null;
  activeAutonomousLeases: number;
  plannedOccurrences: number;
  nextOccurrenceAt: number | null;
  ownerLastActivityAt: number | null;
};

export type RuntimeOverviewReaders = {
  automation():
    | Array<{
        id: string;
        label: string;
        enabled: boolean;
        configured: boolean;
        tickMs: number;
        dependencies?: Record<string, boolean>;
      }>
    | Promise<
        Array<{
          id: string;
          label: string;
          enabled: boolean;
          configured: boolean;
          tickMs: number;
          dependencies?: Record<string, boolean>;
        }>
      >;
  workOrders(): WorkOrderOverviewRead | Promise<WorkOrderOverviewRead>;
  repositoryReviews(): RepositoryReviewOverview[] | Promise<RepositoryReviewOverview[]>;
  dailyAudit():
    | {
        enabled: boolean;
        lastFiredAt?: number;
        summary?: { active: number; failed: number; attention: number; repairPending: number };
        outcomes?: RecentOutcome[];
      }
    | Promise<{
        enabled: boolean;
        lastFiredAt?: number;
        summary?: { active: number; failed: number; attention: number; repairPending: number };
        outcomes?: RecentOutcome[];
      }>;
  runtimeGuardian():
    | {
        enabled: boolean;
        findings: Array<{
          id: string;
          projectId: string;
          kind: string;
          severity: "medium" | "high";
          observedAt: number;
        }>;
      }
    | Promise<{
        enabled: boolean;
        findings: Array<{
          id: string;
          projectId: string;
          kind: string;
          severity: "medium" | "high";
          observedAt: number;
        }>;
      }>;
  resourceGuardian():
    | {
        enabled: boolean;
        mode: string;
        profile: string;
        pressure: string;
        circuit: string;
        changedAt: number;
        degraded: boolean;
        samplingDegraded: boolean;
      }
    | Promise<{
        enabled: boolean;
        mode: string;
        profile: string;
        pressure: string;
        circuit: string;
        changedAt: number;
        degraded: boolean;
        samplingDegraded: boolean;
      }>;
  agentCapacity?(): AgentCapacityOverview | Promise<AgentCapacityOverview>;
  power():
    | {
        mode: string;
        phase: string;
        powerSource: string;
        scheduleStatus: string;
        degraded: boolean;
        service?: {
          uptimeMs: number | null;
          adapters: { telegram: boolean; lark: boolean };
        };
      }
    | Promise<{
        mode: string;
        phase: string;
        powerSource: string;
        scheduleStatus: string;
        degraded: boolean;
        service?: {
          uptimeMs: number | null;
          adapters: { telegram: boolean; lark: boolean };
        };
      }>;
  operator(): OperatorInterfaceView | Promise<OperatorInterfaceView>;
};

type Collected<T> =
  | { ok: true; value: T }
  | { ok: false; errorKind: Exclude<RuntimeDomainView["errorKind"], null> };

const FAILED_WORK_ORDER_ATTENTION_MS = 24 * 60 * 60 * 1_000;
const CLOSED_WORK_ORDER_REPAIR_STATUSES = new Set([
  "completed",
  "fixed",
  "not-needed",
  "blocked",
  "superseded",
  "not-reproducible",
  "dead-letter",
]);

async function collect<T>(reader: () => T | Promise<T>, timeoutMs: number): Promise<Collected<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(reader),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("collector-timeout")), timeoutMs);
      }),
    ]);
    return { ok: true, value: result };
  } catch (error) {
    return {
      ok: false,
      errorKind:
        error instanceof Error && error.message === "collector-timeout" ? "timeout" : "read-failed",
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function domain(
  id: string,
  label: string,
  status: RuntimeDomainView["status"],
  summary: string,
): RuntimeDomainView {
  return { id, label, status, summary, errorKind: null };
}

function failedDomain(
  id: string,
  label: string,
  errorKind: Exclude<RuntimeDomainView["errorKind"], null>,
): RuntimeDomainView {
  return { id, label, status: "degraded", summary: "read unavailable", errorKind };
}

function workOrderView(record: OverviewWorkOrder): ActiveWorkItem {
  return {
    id: `work-order:${record.id}`,
    kind: "work-order",
    label: `${record.projectName}: ${record.taskKind}`,
    status: "running",
    startedAt: record.scheduledAt,
    projectId: record.projectId,
    taskKind: record.taskKind,
  };
}

function workOrderOutcome(record: OverviewWorkOrder): RecentOutcome {
  const status: RecentOutcome["status"] =
    record.status === "completed"
      ? "passed"
      : record.status === "cancelled"
        ? "cancelled"
        : "failed";
  return {
    id: `work-order:${record.id}`,
    domain: "loop",
    label: `${record.projectName}: ${record.taskKind}`,
    status,
    endedAt: record.updatedAt,
    projectId: record.projectId,
  };
}

function isOpenFailedWorkOrder(record: OverviewWorkOrder, now: number): boolean {
  return (
    record.status === "failed" &&
    record.updatedAt <= now &&
    now - record.updatedAt <= FAILED_WORK_ORDER_ATTENTION_MS &&
    !CLOSED_WORK_ORDER_REPAIR_STATUSES.has(record.repairStatus ?? "pending")
  );
}

function attentionForOperator(operator: OperatorInterfaceView, now: number): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (operator.session.state === "attention") {
    items.push({
      id: "operator:session",
      domain: "operator",
      severity: "warning",
      observedAt: now,
      summary: "Home Operator Session needs attention",
      nextAction: "tcb doctor",
      presentation: { kind: "operator-session" },
    });
  }
  if (operator.skills.state === "attention") {
    items.push({
      id: "operator:skills",
      domain: "operator",
      severity: "warning",
      observedAt: now,
      summary: `Home Operator skills ${operator.skills.installed}/${operator.skills.expected} ready`,
      nextAction: "tcb ai-tools status",
      presentation: {
        kind: "operator-skills",
        installed: operator.skills.installed,
        expected: operator.skills.expected,
      },
    });
  }
  if (operator.mcpProfiles.state === "attention") {
    items.push({
      id: "operator:mcp-profiles",
      domain: "operator",
      severity: "warning",
      observedAt: now,
      summary: `Managed MCP profiles ${operator.mcpProfiles.installed}/${operator.mcpProfiles.expected} ready`,
      nextAction: "tcb ai-tools status",
      presentation: {
        kind: "operator-mcp",
        installed: operator.mcpProfiles.installed,
        expected: operator.mcpProfiles.expected,
      },
    });
  }
  if (operator.promptLibrary.state === "attention" || operator.promptLibrary.state === "degraded") {
    items.push({
      id: "operator:prompt-library",
      domain: "operator",
      severity: "warning",
      observedAt: now,
      summary: "Configured Prompt Library is unavailable",
      nextAction: "tcb doctor",
      presentation: { kind: "operator-prompt" },
    });
  }
  return items;
}

export async function readRuntimeOverview(input: {
  now: number;
  sessions: RuntimeOverviewSession[];
  readers: RuntimeOverviewReaders;
  options?: RuntimeOverviewOptions;
  collectorTimeoutMs?: number;
}): Promise<RuntimeOverview> {
  const collectorTimeoutMs = input.collectorTimeoutMs ?? 1_000;
  const [
    automationRead,
    workOrdersRead,
    repositoryReviewsRead,
    dailyAuditRead,
    runtimeGuardianRead,
    resourceGuardianRead,
    agentCapacityRead,
    powerRead,
    operatorRead,
  ] = await Promise.all([
    collect(input.readers.automation, collectorTimeoutMs),
    collect(input.readers.workOrders, collectorTimeoutMs),
    collect(input.readers.repositoryReviews, collectorTimeoutMs),
    collect(input.readers.dailyAudit, collectorTimeoutMs),
    collect(input.readers.runtimeGuardian, collectorTimeoutMs),
    collect(input.readers.resourceGuardian, collectorTimeoutMs),
    collect(
      input.readers.agentCapacity ??
        (() => ({
          enabled: false,
          agent: "claude" as const,
          authentication: "unknown" as const,
          state: "unknown" as const,
          observedAt: 0,
          retryAt: null,
          activeAutonomousLeases: 0,
          plannedOccurrences: 0,
          nextOccurrenceAt: null,
          ownerLastActivityAt: null,
        })),
      collectorTimeoutMs,
    ),
    collect(input.readers.power, collectorTimeoutMs),
    collect(input.readers.operator, collectorTimeoutMs),
  ]);

  const degradedDomains: string[] = [];
  const runtimeDomains: RuntimeDomainView[] = [];
  const attention: AttentionItem[] = [];
  const activeWork: ActiveWorkItem[] = input.sessions
    .filter((session) => session.busy && session.running && !session.operator)
    .map((session) => ({
      id: `session:${session.session}`,
      kind: "interactive",
      label: session.label,
      status: "busy",
      startedAt: session.taskStartedAt ?? input.now,
      session: session.session,
    }));
  const recentOutcomes: RecentOutcome[] = [];
  let automation: AutomationFamilyView[] = [];

  if (workOrdersRead.ok) {
    const value = workOrdersRead.value;
    const recentFailedWorkOrders = value.terminal.filter((candidate) =>
      isOpenFailedWorkOrder(candidate, input.now),
    );
    activeWork.push(...value.unfinished.map(workOrderView));
    recentOutcomes.push(...value.terminal.map(workOrderOutcome));
    for (const record of recentFailedWorkOrders) {
      attention.push({
        id: `work-order:${record.id}`,
        domain: "loop",
        severity: "error",
        observedAt: record.updatedAt,
        summary: `${record.projectName} ${record.taskKind} failed`,
        nextAction: "tcb loop reports list --limit 20",
        projectId: record.projectId,
        presentation: {
          kind: "work-order-failed",
          project: record.projectName,
          taskKind: record.taskKind,
        },
      });
    }
    for (const record of value.abandoned) {
      attention.push({
        id: `work-order:${record.id}:abandoned`,
        domain: "loop",
        severity: "warning",
        observedAt: record.updatedAt,
        summary: `${record.projectName} WorkOrder is abandoned`,
        nextAction: "tcb loop reports list --limit 20",
        projectId: record.projectId,
        presentation: { kind: "work-order-abandoned", project: record.projectName },
      });
    }
    for (const record of value.staleDispatching) {
      attention.push({
        id: `work-order:${record.id}:stale`,
        domain: "loop",
        severity: "warning",
        observedAt: record.updatedAt,
        summary: `${record.projectName} WorkOrder dispatch is stale`,
        nextAction: "tcb logs --grep runtime-guardian --since 24h",
        projectId: record.projectId,
        presentation: { kind: "work-order-stale", project: record.projectName },
      });
    }
    runtimeDomains.push(
      domain(
        "work-orders",
        "WorkOrders",
        recentFailedWorkOrders.length + value.abandoned.length + value.staleDispatching.length > 0
          ? "attention"
          : "healthy",
        `${value.unfinished.length} active, ${value.terminal.length} terminal`,
      ),
    );
  } else {
    degradedDomains.push("work-orders");
    runtimeDomains.push(failedDomain("work-orders", "WorkOrders", workOrdersRead.errorKind));
  }

  if (repositoryReviewsRead.ok) {
    for (const item of repositoryReviewsRead.value) {
      const summary =
        item.status === "retry-wait"
          ? `${item.repositoryId} scheduled for automatic retry`
          : item.status === "manual-review"
            ? `${item.repositoryId} has a verified human boundary`
            : `${item.repositoryId} retry budget exhausted`;
      attention.push({
        id: `repository-review:${item.id}`,
        domain: "repository-reviews",
        severity:
          item.status === "dead-letter"
            ? "error"
            : item.status === "manual-review"
              ? "warning"
              : "info",
        observedAt: item.updatedAt,
        summary,
        nextAction:
          item.status === "retry-wait"
            ? `automatic retry at ${new Date(item.nextAttemptAt).toISOString()}`
            : "tcb loop reports list --limit 20",
        projectId: item.repositoryId,
        presentation: {
          kind: "repository-review",
          project: item.repositoryId,
          status: item.status,
          retryEpoch: item.retryEpoch,
        },
      });
    }
    runtimeDomains.push(
      domain(
        "repository-reviews",
        "Repository PR Reviews",
        repositoryReviewsRead.value.length > 0 ? "attention" : "healthy",
        `${repositoryReviewsRead.value.length} pending operator or recovery item${repositoryReviewsRead.value.length === 1 ? "" : "s"}`,
      ),
    );
  } else {
    degradedDomains.push("repository-reviews");
    runtimeDomains.push(
      failedDomain("repository-reviews", "Repository PR Reviews", repositoryReviewsRead.errorKind),
    );
  }

  if (automationRead.ok) {
    const activeCount = workOrdersRead.ok ? workOrdersRead.value.unfinished.length : 0;
    const loopLastOutcome = workOrdersRead.ok
      ? workOrdersRead.value.terminal
          .map(workOrderOutcome)
          .sort((left, right) => right.endedAt - left.endedAt)[0]
      : undefined;
    const auditLastOutcome = dailyAuditRead.ok
      ? (dailyAuditRead.value.outcomes ?? [])
          .filter((outcome) => outcome.domain === "daily-audit")
          .sort((left, right) => right.endedAt - left.endedAt)[0]
      : undefined;
    automation = automationRead.value.map((item) => ({
      id: item.id,
      label: item.label,
      enabled: item.enabled,
      configured: item.configured,
      tickMs: item.tickMs,
      activeCount:
        item.id === "loop"
          ? activeCount
          : item.id === "task-audit" && dailyAuditRead.ok
            ? (dailyAuditRead.value.summary?.active ?? 0)
            : 0,
      ...(item.dependencies === undefined ? {} : { dependencies: item.dependencies }),
      ...(item.id === "loop" && loopLastOutcome !== undefined
        ? { lastOutcome: { status: loopLastOutcome.status, endedAt: loopLastOutcome.endedAt } }
        : item.id === "task-audit" && auditLastOutcome !== undefined
          ? { lastOutcome: { status: auditLastOutcome.status, endedAt: auditLastOutcome.endedAt } }
          : {}),
    }));
    const dependencyProblems = automationRead.value.filter(
      (item) => item.enabled && Object.values(item.dependencies ?? {}).some((ready) => !ready),
    );
    for (const item of dependencyProblems) {
      attention.push({
        id: `automation:${item.id}:dependency`,
        domain: "automation",
        severity: "warning",
        observedAt: input.now,
        summary: `${item.label} has a disabled dependency`,
        nextAction: "tcb automation status",
        presentation: { kind: "automation-dependency", automation: item.label },
      });
    }
    runtimeDomains.push(
      domain(
        "automation",
        "Automation",
        dependencyProblems.length > 0 ? "attention" : "healthy",
        `${automation.filter((item) => item.enabled).length}/${automation.length} enabled`,
      ),
    );
  } else {
    degradedDomains.push("automation");
    runtimeDomains.push(failedDomain("automation", "Automation", automationRead.errorKind));
  }

  if (dailyAuditRead.ok) {
    const value = dailyAuditRead.value;
    recentOutcomes.push(...(value.outcomes ?? []));
    const summary = value.summary;
    if (value.enabled && (summary?.attention ?? 0) > 0) {
      attention.push({
        id: "daily-task-audit:repair-pending",
        domain: "daily-task-audit",
        severity: "warning",
        observedAt: value.lastFiredAt ?? input.now,
        summary: `${summary?.attention ?? 0} Daily Task Audit item needs attention`,
        nextAction: "tcb logs --grep daily-task-audit --since 7d",
        presentation: { kind: "daily-audit-attention", count: summary?.attention ?? 0 },
      });
    }
    runtimeDomains.push(
      domain(
        "daily-task-audit",
        "Daily Task Audit",
        !value.enabled ? "disabled" : (summary?.attention ?? 0) > 0 ? "attention" : "healthy",
        summary === undefined
          ? value.lastFiredAt === undefined
            ? "no completed run recorded"
            : "last run recorded"
          : `${summary.failed} failed, ${summary.repairPending} repair pending`,
      ),
    );
  } else {
    degradedDomains.push("daily-task-audit");
    runtimeDomains.push(
      failedDomain("daily-task-audit", "Daily Task Audit", dailyAuditRead.errorKind),
    );
  }

  if (runtimeGuardianRead.ok) {
    const value = runtimeGuardianRead.value;
    for (const finding of value.findings) {
      attention.push({
        id: `runtime-guardian:${finding.id}`,
        domain: "runtime-guardian",
        severity: finding.severity === "high" ? "error" : "warning",
        observedAt: finding.observedAt,
        summary: `${finding.projectId}: ${finding.kind}`,
        nextAction: `tcb runtime-guardian findings --project ${finding.projectId} --limit 20`,
        projectId: finding.projectId,
        presentation: {
          kind: "runtime-finding",
          project: finding.projectId,
          findingKind: finding.kind,
        },
      });
    }
    runtimeDomains.push(
      domain(
        "runtime-guardian",
        "Runtime Guardian",
        !value.enabled ? "disabled" : value.findings.length > 0 ? "attention" : "healthy",
        `${value.findings.length} finding${value.findings.length === 1 ? "" : "s"}`,
      ),
    );
  } else {
    degradedDomains.push("runtime-guardian");
    runtimeDomains.push(
      failedDomain("runtime-guardian", "Runtime Guardian", runtimeGuardianRead.errorKind),
    );
  }

  if (resourceGuardianRead.ok) {
    const value = resourceGuardianRead.value;
    if (!value.enabled) {
      // Disabled optional automation is an intentional state, even when no
      // sampler state has ever been persisted on this host.
    } else if (value.degraded || value.samplingDegraded) {
      degradedDomains.push("resource-guardian");
    } else if (value.circuit !== "open" || value.pressure !== "healthy") {
      attention.push({
        id: "resource-guardian:circuit",
        domain: "resource-guardian",
        severity: ["critical", "emergency"].includes(value.pressure) ? "error" : "warning",
        observedAt: value.changedAt,
        summary: `Resource pressure ${value.pressure}; admission ${value.circuit}`,
        nextAction: "tcb resource status --json",
        presentation: {
          kind: "resource-pressure",
          pressure: value.pressure,
          circuit: value.circuit,
        },
      });
    }
    runtimeDomains.push(
      domain(
        "resource-guardian",
        "Resource Guardian",
        !value.enabled
          ? "disabled"
          : value.degraded || value.samplingDegraded
            ? "degraded"
            : value.circuit !== "open" || value.pressure !== "healthy"
              ? "attention"
              : "healthy",
        `${value.pressure}; ${value.circuit}; ${value.mode}/${value.profile}`,
      ),
    );
  } else {
    degradedDomains.push("resource-guardian");
    runtimeDomains.push(
      failedDomain("resource-guardian", "Resource Guardian", resourceGuardianRead.errorKind),
    );
  }

  if (agentCapacityRead.ok) {
    const value = agentCapacityRead.value;
    if (value.enabled && value.state === "unknown") degradedDomains.push("agent-capacity");
    if (value.enabled && (value.state === "constrained" || value.state === "exhausted")) {
      attention.push({
        id: `agent-capacity:${value.agent}`,
        domain: "agent-capacity",
        severity: value.state === "exhausted" ? "error" : "warning",
        observedAt: value.observedAt,
        summary: `${value.agent} capacity is ${value.state}`,
        nextAction: "tcb dashboard --json",
        presentation: { kind: "agent-capacity", agent: value.agent, state: value.state },
      });
    }
    runtimeDomains.push(
      domain(
        "agent-capacity",
        "Agent Capacity",
        !value.enabled
          ? "disabled"
          : value.state === "available"
            ? "healthy"
            : value.state === "unknown"
              ? "degraded"
              : "attention",
        `${value.agent} ${value.authentication}; ${value.state}; ${value.activeAutonomousLeases} active, ${value.plannedOccurrences} planned${value.nextOccurrenceAt === null ? "" : `; next ${new Date(value.nextOccurrenceAt).toISOString()}`}`,
      ),
    );
  } else {
    degradedDomains.push("agent-capacity");
    runtimeDomains.push(
      failedDomain("agent-capacity", "Agent Capacity", agentCapacityRead.errorKind),
    );
  }

  if (powerRead.ok) {
    const value = powerRead.value;
    if (value.degraded || !["verified", "not-required"].includes(value.scheduleStatus)) {
      attention.push({
        id: "power:policy",
        domain: "power",
        severity: "warning",
        observedAt: input.now,
        summary: `Power ${value.mode}/${value.phase}; schedule ${value.scheduleStatus}`,
        nextAction: "tcb power status",
        presentation: {
          kind: "power-policy",
          mode: value.mode,
          phase: value.phase,
          schedule: value.scheduleStatus,
        },
      });
    }
    runtimeDomains.push(
      domain(
        "power",
        "Service and Power",
        value.degraded || !["verified", "not-required"].includes(value.scheduleStatus)
          ? "attention"
          : "healthy",
        [
          `${value.mode}/${value.phase}`,
          value.powerSource,
          `schedule ${value.scheduleStatus}`,
          ...(value.service === undefined
            ? []
            : [
                `up ${value.service.uptimeMs === null ? "unknown" : `${value.service.uptimeMs}ms`}`,
                `telegram ${value.service.adapters.telegram ? "configured" : "not configured"}`,
                `lark ${value.service.adapters.lark ? "configured" : "not configured"}`,
              ]),
        ].join("; "),
      ),
    );
  } else {
    degradedDomains.push("power");
    runtimeDomains.push(failedDomain("power", "Service and Power", powerRead.errorKind));
  }

  const operator = operatorRead.ok
    ? operatorRead.value
    : {
        session: { state: "attention" as const },
        skills: { installed: 0, expected: 0, state: "attention" as const },
        mcpProfiles: { installed: 0, expected: 0, state: "attention" as const, profiles: [] },
        promptLibrary: { state: "disabled" as const },
        optionalProjectMcpCount: null,
      };
  if (operatorRead.ok) {
    const operatorAttention = attentionForOperator(operator, input.now);
    attention.push(...operatorAttention);
    runtimeDomains.push(
      domain(
        "operator-ai",
        "Operator and AI Interfaces",
        operatorAttention.length > 0 ? "attention" : "healthy",
        `${operator.skills.installed}/${operator.skills.expected} skills, ${operator.mcpProfiles.installed}/${operator.mcpProfiles.expected} MCP profiles`,
      ),
    );
  } else {
    degradedDomains.push("operator-ai");
    runtimeDomains.push(
      failedDomain("operator-ai", "Operator and AI Interfaces", operatorRead.errorKind),
    );
  }

  return buildRuntimeOverview(
    {
      attention,
      activeWork,
      automation,
      runtimeDomains,
      operator,
      recentOutcomes,
      degradedDomains,
    },
    input.options,
  );
}
