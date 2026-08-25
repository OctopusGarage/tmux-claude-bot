import type { CpuTotals } from "../infra/system-metrics.js";

export type { CpuTotals } from "../infra/system-metrics.js";

export type ResourceGuardianMode = "observe" | "protect";
export type ResourceGuardianProfile = "balanced" | "conservative";
export type PressureState = "healthy" | "elevated" | "critical" | "emergency" | "recovering";
export type ThermalPressure = "normal" | "pressure" | "unknown";

export type ResourceProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  startedAt: string;
  cpuPct: number;
  rssKb: number;
  command: string;
  cwd?: string;
};

export type ProcessOwnership = {
  classification: "external" | "unknown" | "bot-active" | "bot-terminal" | "bot-stale";
  strong: boolean;
  process: ResourceProcess;
  session?: string;
  workOrderId?: string;
  leaseId?: string;
  evidence: string[];
};

export type DeepResourceSnapshot = {
  capturedAt: number;
  thermal: ThermalPressure;
  processes: ResourceProcess[];
};

export type LightweightProbe = {
  cpuTotals(): CpuTotals;
  loadAverage(): readonly [number, number, number];
  cpuCount(): number;
};

export type DeepResourceProbe = () => Promise<DeepResourceSnapshot>;

export type ResourceSample = {
  capturedAt: number;
  hostCpuPct: number;
  hostCpuStatus?: "available" | "unavailable";
  loadPct: number;
  eventLoopLagMs: number;
  thermal: ThermalPressure;
  /** Present only for an explicitly requested, expensive diagnostic sample. */
  deepSnapshot?: DeepResourceSnapshot;
};

export type PressureMemory = {
  pressure: PressureState;
  stateSince: number;
  elevatedSince: number | null;
  criticalSince: number | null;
  emergencySince: number | null;
  thermalSince: number | null;
  recoverySince: number | null;
};

export type PressureProfile = {
  elevatedCpuPct: number;
  elevatedSustainMs: number;
  criticalCpuPct: number;
  criticalSustainMs: number;
  emergencyCpuPct: number;
  emergencySustainMs: number;
  thermalSustainMs: number;
  recoveryCpuPct: number;
  recoveringAfterMs: number;
  healthyAfterMs: number;
};

export type ResourceCircuitAdmission = "open" | "heavy-closed" | "background-closed";
export type ResourceSamplingNotificationPhase = "sampling-failed" | "stale-hold-expired";

export type ResourceSamplingHealth = {
  degraded: boolean;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastError: string | null;
  notifiedPhase: ResourceSamplingNotificationPhase | null;
  overlapSkippedTicks: number;
};

export type ResourceCircuitState = {
  schemaVersion: 1;
  pressure: PressureState;
  incidentId: string | null;
  admission: ResourceCircuitAdmission;
  reason: string;
  changedAt: number;
  lastSampleAt: number;
  owner: "resource-guardian";
};

export type ResourceAdmissionInput = {
  source:
    | "loop-engineering"
    | "daily-task-audit"
    | "runtime-guardian"
    | "project-recovery"
    | "autopilot-delegate"
    | "resource-guardian";
  trigger: "interactive" | "operator" | "background" | "reconcile" | "resource-repair";
  weight: "light" | "heavy";
  now: number;
  forced?: boolean;
};

export type ResourceAdmission =
  | { allowed: true; reason: string; incidentId: string | null }
  | { allowed: false; reason: string; incidentId: string | null };

export type ResourceIncidentTransition = {
  at: number;
  from: PressureState;
  to: PressureState;
  hostCpuPct: number;
  circuit: ResourceCircuitAdmission;
  reason: string;
};

export type ResourceIncidentAction = {
  kind: "transition" | "notification" | "sampling-degraded" | "overlap-skipped" | "resource-action";
  at: number;
  outcome: "recorded" | "sent" | "partial" | "failed" | "skipped";
  reason: string;
  /** Explicit lifecycle phase; legacy unphased action evidence never authorizes repair. */
  phase?: "deterministic-cleanup" | "repair-intent" | "repair-dispatch";
  /** Identity proof recorded before a protect-mode destructive action. */
  target?: {
    pid: number;
    startedAt: string;
    workOrderId: string;
    session?: string;
    leaseId?: string;
  };
  count?: number;
};

export type ResourceIncident = {
  schemaVersion: 1;
  id: string;
  fingerprint: string;
  attribution: "bot-owned" | "external" | "unknown";
  startedAt: number;
  endedAt?: number;
  pressure: PressureState;
  samples: ResourceSample[];
  transitions: ResourceIncidentTransition[];
  actions: ResourceIncidentAction[];
  repairWorkOrderId?: string;
};

export type ResourceGuardianView = {
  enabled: boolean;
  mode: ResourceGuardianMode;
  profile: ResourceGuardianProfile;
  pressure: PressureState;
  circuit: ResourceCircuitAdmission;
  incidentId: string | null;
  reason: string;
  attribution: ResourceIncident["attribution"];
  latestSample: ResourceSample | null;
  sampling: ResourceSamplingHealth;
  /** Durable healthy-window anchor for stable recovery; null outside healthy pressure. */
  stableSince: number | null;
};

export type ResourceGuardianOperatorState = {
  schemaVersion: 1;
  mode: ResourceGuardianMode;
  profile: ResourceGuardianProfile;
  updatedAt: number;
};
