export type OverviewHealthStatus = "healthy" | "attention" | "degraded";

export type AttentionSeverity = "error" | "warning" | "info";

export type AttentionItem = {
  id: string;
  domain: string;
  severity: AttentionSeverity;
  observedAt: number;
  summary: string;
  nextAction: string;
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
};

export type AutomationFamilyView = {
  id: string;
  label: string;
  enabled: boolean;
  configured: boolean;
  activeCount: number;
  tickMs?: number;
};

export type RuntimeDomainView = {
  id: string;
  label: string;
  status: "healthy" | "attention" | "degraded" | "disabled";
  summary: string;
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
  };
  promptLibrary: { state: OperatorInterfaceState };
  optionalProjectMcpCount: number;
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
  const attention = [...input.attention].sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      right.observedAt - left.observedAt ||
      left.id.localeCompare(right.id),
  );
  const activeWork = [...input.activeWork].sort(
    (left, right) => right.startedAt - left.startedAt || left.id.localeCompare(right.id),
  );
  const recentOutcomes = [...input.recentOutcomes].sort(
    (left, right) => right.endedAt - left.endedAt || left.id.localeCompare(right.id),
  );
  const degradedDomains = [...new Set(input.degradedDomains)].sort();
  const degradedDomainCount = new Set([
    ...degradedDomains,
    ...input.runtimeDomains
      .filter((domain) => domain.status === "degraded")
      .map((domain) => domain.id),
  ]).size;
  const hasAttentionDomain = input.runtimeDomains.some((domain) => domain.status === "attention");
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
    automation: [...input.automation].sort((left, right) => left.id.localeCompare(right.id)),
    runtimeDomains: [...input.runtimeDomains].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    operator: input.operator,
    recentOutcomes: bounded(recentOutcomes, normalizedLimit(options.recentOutcomeLimit)),
    degradedDomains,
  };
}
