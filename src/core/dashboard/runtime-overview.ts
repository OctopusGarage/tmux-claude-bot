export type OverviewHealthStatus = "healthy" | "attention" | "degraded";

export type AttentionSeverity = "error" | "warning" | "info";

export type AttentionPresentation =
  | { kind: "operator-session" }
  | { kind: "operator-skills"; installed: number; expected: number }
  | { kind: "operator-mcp"; installed: number; expected: number }
  | { kind: "operator-prompt" }
  | { kind: "work-order-failed"; project: string; taskKind: string }
  | { kind: "work-order-abandoned"; project: string }
  | { kind: "work-order-stale"; project: string }
  | { kind: "automation-dependency"; automation: string }
  | { kind: "daily-audit-attention"; count: number }
  | { kind: "runtime-finding"; project: string; findingKind: string }
  | { kind: "resource-pressure"; pressure: string; circuit: string }
  | { kind: "agent-capacity"; agent: string; state: string }
  | { kind: "power-policy"; mode: string; phase: string; schedule: string }
  | {
      kind: "repository-review";
      project: string;
      status: "retry-wait" | "manual-review" | "dead-letter";
      retryEpoch: number;
    };

export type AttentionItem = {
  id: string;
  domain: string;
  severity: AttentionSeverity;
  observedAt: number;
  summary: string;
  nextAction: string;
  projectId?: string;
  presentation?: AttentionPresentation;
};

export type ActiveWorkItem = {
  id: string;
  kind: "work-order" | "interactive";
  label: string;
  status: "running" | "busy";
  startedAt: number;
  projectId?: string;
  taskKind?: string;
  session?: string;
};

export type RecentOutcome = {
  id: string;
  domain: string;
  label: string;
  status: "passed" | "failed" | "cancelled";
  endedAt: number;
  projectId?: string;
};

export type AutomationFamilyView = {
  id: string;
  label: string;
  enabled: boolean;
  configured: boolean;
  activeCount: number;
  tickMs?: number;
  dependencies?: Record<string, boolean>;
  lastOutcome?: Pick<RecentOutcome, "status" | "endedAt">;
};

export type RuntimeDomainView = {
  id: string;
  label: string;
  status: "healthy" | "attention" | "degraded" | "disabled";
  summary: string;
  errorKind: "read-failed" | "timeout" | null;
};

export type OperatorInterfaceState = "ready" | "attention" | "disabled";

export type OperatorInterfaceView = {
  session: { state: OperatorInterfaceState };
  skills: {
    installed: number;
    expected: number;
    state: OperatorInterfaceState;
  };
  mcpProfiles: {
    installed: number;
    expected: number;
    state: OperatorInterfaceState;
    profiles: Array<{
      profile: "observer" | "home";
      role: "observer" | "home-operator";
      exposure: "read-only" | "controlled-operation";
      toolCount: number;
      descriptorState: "ready" | "missing" | "stale";
    }>;
  };
  promptLibrary: { state: OperatorInterfaceState | "configured" | "degraded" };
  /** @deprecated Project-scoped diagnostics own this value; null means not observed globally. */
  optionalProjectMcpCount: number | null;
};

export type BoundedSection<T> = {
  items: T[];
  total: number;
  limit: number;
  truncated: boolean;
};

export type RuntimeOverviewInput = {
  attention: AttentionItem[];
  activeWork: ActiveWorkItem[];
  automation: AutomationFamilyView[];
  runtimeDomains: RuntimeDomainView[];
  operator: OperatorInterfaceView;
  recentOutcomes: RecentOutcome[];
  degradedDomains: string[];
};

export type RuntimeOverview = {
  health: {
    status: OverviewHealthStatus;
    attentionCount: number;
    degradedDomainCount: number;
  };
  attention: BoundedSection<AttentionItem>;
  activeWork: BoundedSection<ActiveWorkItem>;
  automation: AutomationFamilyView[];
  runtimeDomains: RuntimeDomainView[];
  operator: OperatorInterfaceView;
  recentOutcomes: BoundedSection<RecentOutcome>;
  degradedDomains: string[];
};

export type RuntimeOverviewOptions = {
  attentionLimit?: number;
  activeWorkLimit?: number;
  recentOutcomeLimit?: number;
  project?: string;
  problemsOnly?: boolean;
};

const DEFAULT_SECTION_LIMIT = 10;
const MAX_SECTION_LIMIT = 100;

const severityRank: Record<AttentionSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function normalizedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SECTION_LIMIT;
  return Math.min(MAX_SECTION_LIMIT, Math.max(0, Math.floor(value)));
}

function bounded<T>(items: T[], limit: number): BoundedSection<T> {
  return {
    items: items.slice(0, limit),
    total: items.length,
    limit,
    truncated: items.length > limit,
  };
}

export function buildRuntimeOverview(
  input: RuntimeOverviewInput,
  options: RuntimeOverviewOptions = {},
): RuntimeOverview {
  const project = options.project?.trim().toLowerCase();
  const matchesProject = (item: { projectId?: string; label?: string }): boolean =>
    project === undefined ||
    project.length === 0 ||
    item.projectId?.toLowerCase() === project ||
    item.label?.toLowerCase().includes(project) === true;
  const attention = input.attention
    .filter(
      (item) =>
        project === undefined ||
        item.projectId === undefined ||
        item.projectId.toLowerCase() === project,
    )
    .sort(
      (left, right) =>
        severityRank[left.severity] - severityRank[right.severity] ||
        right.observedAt - left.observedAt ||
        left.id.localeCompare(right.id),
    );
  const activeWork = (options.problemsOnly ? [] : input.activeWork.filter(matchesProject)).sort(
    (left, right) => right.startedAt - left.startedAt || left.id.localeCompare(right.id),
  );
  const recentOutcomes = (
    options.problemsOnly ? [] : input.recentOutcomes.filter(matchesProject)
  ).sort((left, right) => right.endedAt - left.endedAt || left.id.localeCompare(right.id));
  const degradedDomains = [...new Set(input.degradedDomains)].sort();
  const runtimeDomains = input.runtimeDomains.filter(
    (domain) =>
      project === undefined ||
      domain.status === "degraded" ||
      !["work-orders", "runtime-guardian"].includes(domain.id),
  );
  const degradedDomainCount = new Set([
    ...degradedDomains,
    ...runtimeDomains.filter((domain) => domain.status === "degraded").map((domain) => domain.id),
  ]).size;
  const hasAttentionDomain =
    project === undefined && runtimeDomains.some((domain) => domain.status === "attention");
  const status: OverviewHealthStatus =
    degradedDomainCount > 0
      ? "degraded"
      : attention.length > 0 || hasAttentionDomain
        ? "attention"
        : "healthy";

  return {
    health: {
      status,
      attentionCount: attention.length,
      degradedDomainCount,
    },
    attention: bounded(attention, normalizedLimit(options.attentionLimit)),
    activeWork: bounded(activeWork, normalizedLimit(options.activeWorkLimit)),
    automation: (options.problemsOnly ? [] : [...input.automation]).sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    runtimeDomains: (options.problemsOnly
      ? runtimeDomains.filter((domain) => !["healthy", "disabled"].includes(domain.status))
      : [...runtimeDomains]
    ).sort((left, right) => left.id.localeCompare(right.id)),
    operator: input.operator,
    recentOutcomes: bounded(recentOutcomes, normalizedLimit(options.recentOutcomeLimit)),
    degradedDomains,
  };
}
