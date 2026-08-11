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
};

export type WorkOrderOverviewRead = {
  unfinished: OverviewWorkOrder[];
  terminal: OverviewWorkOrder[];
  abandoned: OverviewWorkOrder[];
  staleDispatching: OverviewWorkOrder[];
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
  batch():
    | {
        enabled: boolean;
        active?: { id: string; label: string; status: string; startedAt: number };
      }
    | Promise<{
        enabled: boolean;
        active?: { id: string; label: string; status: string; startedAt: number };
      }>;
  dailyAudit():
    | { enabled: boolean; lastFiredAt?: number }
    | Promise<{ enabled: boolean; lastFiredAt?: number }>;
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
  power():
    | {
        mode: string;
        phase: string;
        powerSource: string;
        scheduleStatus: string;
        degraded: boolean;
      }
    | Promise<{
        mode: string;
        phase: string;
        powerSource: string;
        scheduleStatus: string;
        degraded: boolean;
      }>;
  operator(): OperatorInterfaceView | Promise<OperatorInterfaceView>;
};

type Collected<T> = { ok: true; value: T } | { ok: false };

const FAILED_WORK_ORDER_ATTENTION_MS = 24 * 60 * 60 * 1_000;

async function collect<T>(reader: () => T | Promise<T>): Promise<Collected<T>> {
  try {
    return { ok: true, value: await reader() };
  } catch {
    return { ok: false };
  }
}

function domain(
  id: string,
  label: string,
  status: RuntimeDomainView["status"],
  summary: string,
): RuntimeDomainView {
  return { id, label, status, summary };
}

function failedDomain(id: string, label: string): RuntimeDomainView {
  return domain(id, label, "degraded", "read unavailable");
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
  };
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
    });
  }
  if (operator.promptLibrary.state === "attention") {
    items.push({
      id: "operator:prompt-library",
      domain: "operator",
      severity: "warning",
      observedAt: now,
      summary: "Configured Prompt Library is unavailable",
      nextAction: "tcb doctor",
    });
  }
  return items;
}

export async function readRuntimeOverview(input: {
  now: number;
  sessions: RuntimeOverviewSession[];
  readers: RuntimeOverviewReaders;
  options?: RuntimeOverviewOptions;
}): Promise<RuntimeOverview> {
  const [
    automationRead,
    workOrdersRead,
    batchRead,
    dailyAuditRead,
    runtimeGuardianRead,
    resourceGuardianRead,
    powerRead,
    operatorRead,
  ] = await Promise.all([
    collect(input.readers.automation),
    collect(input.readers.workOrders),
    collect(input.readers.batch),
    collect(input.readers.dailyAudit),
    collect(input.readers.runtimeGuardian),
    collect(input.readers.resourceGuardian),
    collect(input.readers.power),
    collect(input.readers.operator),
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
    const recentFailedWorkOrders = value.terminal.filter(
      (candidate) =>
        candidate.status === "failed" &&
        candidate.updatedAt <= input.now &&
        input.now - candidate.updatedAt <= FAILED_WORK_ORDER_ATTENTION_MS,
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
      });
    }
    for (const record of value.staleDispatching) {
      attention.push({
        id: `work-order:${record.id}:stale`,
        domain: "loop",
        severity: "warning",
        observedAt: record.updatedAt,
        summary: `${record.projectName} WorkOrder dispatch is stale`,
        nextAction: "tcb runtime-guardian findings --json",
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
    runtimeDomains.push(failedDomain("work-orders", "WorkOrders"));
  }

  if (automationRead.ok) {
    const activeCount = workOrdersRead.ok ? workOrdersRead.value.unfinished.length : 0;
    automation = automationRead.value.map((item) => ({
      id: item.id,
      label: item.label,
      enabled: item.enabled,
      configured: item.configured,
      tickMs: item.tickMs,
      activeCount: item.id === "loop" ? activeCount : 0,
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
    runtimeDomains.push(failedDomain("automation", "Automation"));
  }

  if (batchRead.ok) {
    const value = batchRead.value;
    if (value.active !== undefined) {
      activeWork.push({
        id: `batch:${value.active.id}`,
        kind: "work-order",
        label: value.active.label,
        status: "running",
        startedAt: value.active.startedAt,
        taskKind: "batch",
      });
    }
    runtimeDomains.push(
      domain(
        "batch",
        "Batch Scheduler",
        value.enabled ? "healthy" : "disabled",
        value.active === undefined ? "idle" : `active: ${value.active.status}`,
      ),
    );
  } else {
    degradedDomains.push("batch");
    runtimeDomains.push(failedDomain("batch", "Batch Scheduler"));
  }

  if (dailyAuditRead.ok) {
    const value = dailyAuditRead.value;
    runtimeDomains.push(
      domain(
        "daily-task-audit",
        "Daily Task Audit",
        value.enabled ? "healthy" : "disabled",
        value.lastFiredAt === undefined ? "no completed run recorded" : "last run recorded",
      ),
    );
  } else {
    degradedDomains.push("daily-task-audit");
    runtimeDomains.push(failedDomain("daily-task-audit", "Daily Task Audit"));
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
        nextAction: "tcb runtime-guardian findings --json",
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
    runtimeDomains.push(failedDomain("runtime-guardian", "Runtime Guardian"));
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
    runtimeDomains.push(failedDomain("resource-guardian", "Resource Guardian"));
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
      });
    }
    runtimeDomains.push(
      domain(
        "power",
        "Service and Power",
        value.degraded || !["verified", "not-required"].includes(value.scheduleStatus)
          ? "attention"
          : "healthy",
        `${value.mode}/${value.phase}; ${value.powerSource}; schedule ${value.scheduleStatus}`,
      ),
    );
  } else {
    degradedDomains.push("power");
    runtimeDomains.push(failedDomain("power", "Service and Power"));
  }

  const operator = operatorRead.ok
    ? operatorRead.value
    : {
        session: { state: "attention" as const },
        skills: { installed: 0, expected: 0, state: "attention" as const },
        mcpProfiles: { installed: 0, expected: 0, state: "attention" as const },
        promptLibrary: { state: "disabled" as const },
        optionalProjectMcpCount: 0,
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
    runtimeDomains.push(failedDomain("operator-ai", "Operator and AI Interfaces"));
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
