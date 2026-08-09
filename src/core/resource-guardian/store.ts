import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";
import type {
  PressureState,
  ResourceCircuitAdmission,
  ResourceCircuitState,
  ResourceGuardianOperatorState,
  ResourceGuardianView,
  ResourceIncident,
  ResourceIncidentAction,
  ResourceIncidentTransition,
  ResourceSample,
  ResourceSamplingHealth,
} from "./types.js";

const INCIDENT_LIMIT = 50;
const INCIDENT_BYTES_LIMIT = 10 * 1024 * 1024;

const pressures = new Set<PressureState>([
  "healthy",
  "elevated",
  "critical",
  "emergency",
  "recovering",
]);
const admissions = new Set<ResourceCircuitAdmission>(["open", "heavy-closed", "background-closed"]);

export type ResourceGuardianCurrentState = {
  circuit: ResourceCircuitState;
  view: ResourceGuardianView;
};

export type ResourceGuardianCurrentRead = ResourceGuardianCurrentState & { degraded: boolean };

export type ResourceGuardianStore = {
  readonly paths: { state: string; incidents: string; operator: string };
  /** Recovery-capable read for coordinators: quarantines invalid state bytes. */
  readCurrent(): ResourceGuardianCurrentRead;
  /** Fresh read for admission: never writes, renames, or creates files. */
  readCurrentReadOnly(): ResourceGuardianCurrentRead;
  writeCurrent(current: ResourceGuardianCurrentState): void;
  readOperator(): ResourceGuardianOperatorState | null;
  writeOperator(operator: ResourceGuardianOperatorState): void;
  writeIncident(incident: ResourceIncident): void;
  listIncidents(): ResourceIncident[];
  pruneIncidents(): void;
};

export type CreateResourceGuardianStoreOptions = {
  rootDir?: string;
  /** Canonical app state directory. No additional `state` segment is added. */
  stateDir?: string;
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableId(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isSample(value: unknown): value is ResourceSample {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.capturedAt) &&
    isFiniteNumber(value.hostCpuPct) &&
    isFiniteNumber(value.loadPct) &&
    isFiniteNumber(value.eventLoopLagMs) &&
    (value.thermal === "normal" || value.thermal === "pressure" || value.thermal === "unknown") &&
    (value.deepSnapshot === undefined || isDeepSnapshot(value.deepSnapshot))
  );
}

function isDeepSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.capturedAt) &&
    (value.thermal === "normal" || value.thermal === "pressure" || value.thermal === "unknown") &&
    Array.isArray(value.processes) &&
    value.processes.every(isResourceProcess)
  );
}

function isResourceProcess(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.pid) &&
    isFiniteNumber(value.ppid) &&
    isFiniteNumber(value.pgid) &&
    typeof value.startedAt === "string" &&
    isFiniteNumber(value.cpuPct) &&
    isFiniteNumber(value.rssKb) &&
    typeof value.command === "string" &&
    (value.cwd === undefined || typeof value.cwd === "string")
  );
}

function isCircuit(value: unknown): value is ResourceCircuitState {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    typeof value.pressure === "string" &&
    pressures.has(value.pressure as PressureState) &&
    isNullableId(value.incidentId) &&
    typeof value.admission === "string" &&
    admissions.has(value.admission as ResourceCircuitAdmission) &&
    typeof value.reason === "string" &&
    isFiniteNumber(value.changedAt) &&
    isFiniteNumber(value.lastSampleAt) &&
    value.owner === "resource-guardian"
  );
}

function isSamplingHealth(value: unknown): value is ResourceSamplingHealth {
  return (
    isRecord(value) &&
    typeof value.degraded === "boolean" &&
    isFiniteNumber(value.consecutiveFailures) &&
    Number.isInteger(value.consecutiveFailures) &&
    value.consecutiveFailures >= 0 &&
    (value.lastFailureAt === null || isFiniteNumber(value.lastFailureAt)) &&
    (value.lastError === null || typeof value.lastError === "string") &&
    (value.notifiedPhase === null ||
      value.notifiedPhase === "sampling-failed" ||
      value.notifiedPhase === "stale-hold-expired") &&
    isFiniteNumber(value.overlapSkippedTicks) &&
    Number.isInteger(value.overlapSkippedTicks) &&
    value.overlapSkippedTicks >= 0
  );
}

function isView(value: unknown, allowLegacySampling = false): value is ResourceGuardianView {
  if (!isRecord(value)) return false;
  return (
    typeof value.enabled === "boolean" &&
    (value.mode === "observe" || value.mode === "protect") &&
    (value.profile === "balanced" || value.profile === "conservative") &&
    typeof value.pressure === "string" &&
    pressures.has(value.pressure as PressureState) &&
    typeof value.circuit === "string" &&
    admissions.has(value.circuit as ResourceCircuitAdmission) &&
    isNullableId(value.incidentId) &&
    typeof value.reason === "string" &&
    (value.attribution === "bot-owned" ||
      value.attribution === "external" ||
      value.attribution === "unknown") &&
    (value.latestSample === null || isSample(value.latestSample)) &&
    (isSamplingHealth(value.sampling) || (allowLegacySampling && value.sampling === undefined))
  );
}

function isCurrent(
  value: unknown,
  allowLegacySampling = false,
): value is ResourceGuardianCurrentState {
  if (!isRecord(value) || !isCircuit(value.circuit) || !isView(value.view, allowLegacySampling))
    return false;
  return (
    value.circuit.pressure === value.view.pressure &&
    value.circuit.admission === value.view.circuit &&
    value.circuit.incidentId === value.view.incidentId &&
    value.circuit.reason === value.view.reason &&
    (value.view.mode !== "observe" || value.circuit.admission === "open")
  );
}

function isIncidentTransition(value: unknown): value is ResourceIncidentTransition {
  return (
    isRecord(value) &&
    isFiniteNumber(value.at) &&
    typeof value.from === "string" &&
    pressures.has(value.from as PressureState) &&
    typeof value.to === "string" &&
    pressures.has(value.to as PressureState) &&
    isFiniteNumber(value.hostCpuPct) &&
    typeof value.circuit === "string" &&
    admissions.has(value.circuit as ResourceCircuitAdmission) &&
    typeof value.reason === "string"
  );
}

function isIncidentAction(value: unknown): value is ResourceIncidentAction {
  return (
    isRecord(value) &&
    (value.kind === "transition" ||
      value.kind === "notification" ||
      value.kind === "sampling-degraded" ||
      value.kind === "overlap-skipped") &&
    isFiniteNumber(value.at) &&
    (value.outcome === "recorded" ||
      value.outcome === "sent" ||
      value.outcome === "partial" ||
      value.outcome === "failed" ||
      value.outcome === "skipped") &&
    typeof value.reason === "string" &&
    (value.count === undefined ||
      (isFiniteNumber(value.count) && Number.isInteger(value.count) && value.count >= 0))
  );
}

function isOperator(value: unknown): value is ResourceGuardianOperatorState {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    (value.mode === "observe" || value.mode === "protect") &&
    (value.profile === "balanced" || value.profile === "conservative") &&
    isFiniteNumber(value.updatedAt)
  );
}

function isIncident(value: unknown): value is ResourceIncident {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.id === "string" &&
    typeof value.fingerprint === "string" &&
    (value.attribution === "bot-owned" ||
      value.attribution === "external" ||
      value.attribution === "unknown") &&
    isFiniteNumber(value.startedAt) &&
    (value.endedAt === undefined || isFiniteNumber(value.endedAt)) &&
    typeof value.pressure === "string" &&
    pressures.has(value.pressure as PressureState) &&
    Array.isArray(value.samples) &&
    value.samples.every(isSample) &&
    Array.isArray(value.transitions) &&
    value.transitions.every(isIncidentTransition) &&
    Array.isArray(value.actions) &&
    value.actions.every(isIncidentAction) &&
    (value.repairWorkOrderId === undefined || typeof value.repairWorkOrderId === "string")
  );
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function uniqueCorruptPath(file: string, epoch: number): string {
  const base = `${file}.corrupt-${epoch}`;
  let candidate = base;
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function quarantine(file: string, now: number): void {
  try {
    fs.renameSync(file, uniqueCorruptPath(file, now));
  } catch {
    // Quarantine is recovery work. A failure must not make the bot unavailable.
  }
}

function hasCorruptEvidence(file: string): boolean {
  const prefix = `${path.basename(file)}.corrupt-`;
  try {
    return fs
      .readdirSync(path.dirname(file), { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.startsWith(prefix));
  } catch {
    return false;
  }
}

function fallbackCurrent(now: number, hasInvalidState: boolean): ResourceGuardianCurrentRead {
  const admission: ResourceCircuitAdmission = hasInvalidState ? "background-closed" : "open";
  const pressure: PressureState = hasInvalidState ? "critical" : "healthy";
  const reason = hasInvalidState
    ? "resource guardian state is invalid; observing with background work closed"
    : "resource guardian state is absent; observing only";
  const circuit: ResourceCircuitState = {
    schemaVersion: 1,
    pressure,
    incidentId: null,
    admission,
    reason,
    changedAt: now,
    lastSampleAt: now,
    owner: "resource-guardian",
  };
  return {
    circuit,
    view: {
      enabled: false,
      mode: "observe",
      profile: "balanced",
      pressure,
      circuit: admission,
      incidentId: null,
      reason,
      attribution: "unknown",
      latestSample: null,
      sampling: legacySamplingHealth(),
    },
    degraded: true,
  };
}

function legacySamplingHealth(): ResourceSamplingHealth {
  return {
    degraded: true,
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastError: null,
    notifiedPhase: null,
    overlapSkippedTicks: 0,
  };
}

function normalizeCurrent(value: unknown): ResourceGuardianCurrentState | null {
  if (isCurrent(value)) return value;
  if (!isCurrent(value, true) || !isRecord(value.view) || value.view.sampling !== undefined) {
    return null;
  }
  return {
    circuit: value.circuit,
    view: {
      ...(value.view as Omit<ResourceGuardianView, "sampling">),
      sampling: legacySamplingHealth(),
    },
  };
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function createResourceGuardianStore(
  options: CreateResourceGuardianStoreOptions = {},
): ResourceGuardianStore {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const now = options.now ?? Date.now;
  const stateRoot =
    options.stateDir !== undefined
      ? path.join(path.resolve(options.stateDir), "resource-guardian")
      : path.join(rootDir, "state", "resource-guardian");
  const paths = {
    state: path.join(stateRoot, "state.json"),
    incidents: path.join(stateRoot, "incidents"),
    operator: path.join(stateRoot, "operator.json"),
  };

  const readCurrentFromDisk = (quarantineInvalidState: boolean): ResourceGuardianCurrentRead => {
    let raw: string;
    try {
      raw = fs.readFileSync(paths.state, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return fallbackCurrent(now(), hasCorruptEvidence(paths.state));
      }
      return fallbackCurrent(now(), true);
    }
    const parsed = parseJson(raw);
    const current = normalizeCurrent(parsed);
    if (current) return { ...current, degraded: false };
    if (quarantineInvalidState) quarantine(paths.state, now());
    return fallbackCurrent(now(), true);
  };

  const writeCurrent = (current: ResourceGuardianCurrentState): void => {
    if (!isCurrent(current)) throw new Error("Invalid resource guardian current state");
    writeFileAtomicSync(paths.state, serialize(current));
  };

  const incidentEntries = (): Array<{
    file: string;
    fileName: string;
    size: number;
    sortAt: number;
    id: string;
  }> => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(paths.incidents, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      return [];
    }
    return entries.flatMap((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return [];
      const file = path.join(paths.incidents, entry.name);
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        return [];
      }
      const parsed = parseJson(readFileOrEmpty(file));
      if (isIncident(parsed)) {
        return [
          {
            file,
            fileName: entry.name,
            size,
            sortAt: parsed.endedAt ?? parsed.startedAt,
            id: parsed.id,
          },
        ];
      }
      return [
        { file, fileName: entry.name, size, sortAt: Number.NEGATIVE_INFINITY, id: entry.name },
      ];
    });
  };

  const pruneIncidents = (): void => {
    const entries = incidentEntries().sort(
      (left, right) =>
        left.sortAt - right.sortAt ||
        left.id.localeCompare(right.id) ||
        left.fileName.localeCompare(right.fileName),
    );
    let count = entries.length;
    let totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
    for (const entry of entries) {
      if (count <= INCIDENT_LIMIT && totalBytes <= INCIDENT_BYTES_LIMIT) break;
      try {
        fs.unlinkSync(entry.file);
        count -= 1;
        totalBytes -= entry.size;
      } catch {
        // Leave an undeletable record for a future pass; current protection must continue.
      }
    }
  };

  return {
    paths,
    readCurrent: () => readCurrentFromDisk(true),
    readCurrentReadOnly: () => readCurrentFromDisk(false),
    writeCurrent,
    readOperator: () => {
      let raw: string;
      try {
        raw = fs.readFileSync(paths.operator, "utf8");
      } catch {
        return null;
      }
      const parsed = parseJson(raw);
      if (isOperator(parsed)) return parsed;
      quarantine(paths.operator, now());
      return null;
    },
    writeOperator: (operator) => {
      if (!isOperator(operator)) throw new Error("Invalid resource guardian operator state");
      writeFileAtomicSync(paths.operator, serialize(operator));
    },
    writeIncident: (incident) => {
      if (!isIncident(incident)) throw new Error("Invalid resource guardian incident");
      if (incident.id.includes(path.sep) || incident.id.includes("/")) {
        throw new Error("Resource guardian incident id must not contain a path separator");
      }
      writeFileAtomicSync(path.join(paths.incidents, `${incident.id}.json`), serialize(incident));
      pruneIncidents();
    },
    listIncidents: () =>
      incidentEntries().flatMap((entry) => {
        const parsed = parseJson(readFileOrEmpty(entry.file));
        return isIncident(parsed) ? [parsed] : [];
      }),
    pruneIncidents,
  };
}

function readFileOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
