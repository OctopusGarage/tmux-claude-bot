import { appStateDir } from "../../shared/state-dir.js";
import { tildeifyHome, tildeifyHomeDeep } from "../../shared/utils/path.js";
import { readConfigEnvironment, writeConfigEnvironment } from "../config/env-store.js";
import { writeResourceGuardianOperatorUpdate } from "./operator-update.js";
import { sanitizeResourceGuardianText } from "./presentation.js";
import { createResourceGuardianStore, type ResourceGuardianStore } from "./store.js";
import type {
  ResourceGuardianMode,
  ResourceGuardianOperatorState,
  ResourceGuardianProfile,
  ResourceGuardianView,
  ResourceIncident,
  ResourceSample,
} from "./types.js";

type CommandResult =
  | { exitCode: 0; stdout: string; stderr?: never }
  | { exitCode: 1; stderr: string; stdout?: never };

const DEFAULT_INCIDENT_LIMIT = 20;
const MAX_INCIDENT_LIMIT = 50;
const DEFAULT_TICK_MS = 15_000;
const modes = new Set<ResourceGuardianMode>(["observe", "protect"]);
const profiles = new Set<ResourceGuardianProfile>(["balanced", "conservative"]);

function jsonOption(args: string[]): boolean | string {
  for (const arg of args) {
    if (arg !== "--json") return `unknown option "${arg}"`;
  }
  return args.includes("--json");
}

function enabled(env: Map<string, string>): boolean {
  return (env.get("RESOURCE_GUARDIAN_ENABLED") ?? "false").trim().toLowerCase() === "true";
}

function tickMs(env: Map<string, string>): number {
  const raw = env.get("RESOURCE_GUARDIAN_TICK_MS")?.trim();
  const value = Number(raw === undefined || raw === "" ? DEFAULT_TICK_MS : raw);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function configuredMode(env: Map<string, string>): ResourceGuardianMode {
  const value = env.get("RESOURCE_GUARDIAN_MODE")?.trim();
  return value === "protect" ? "protect" : "observe";
}

function configuredProfile(env: Map<string, string>): ResourceGuardianProfile {
  const value = env.get("RESOURCE_GUARDIAN_PROFILE")?.trim();
  return value === "conservative" ? "conservative" : "balanced";
}

function publicSample(sample: ResourceSample): Omit<
  ResourceSample,
  "deepSnapshot" | "hostCpuPct"
> & {
  hostCpuPct: number | null;
  deepSnapshot?: {
    capturedAt: number;
    thermal: ResourceSample["thermal"];
    processes: Array<
      Omit<NonNullable<ResourceSample["deepSnapshot"]>["processes"][number], "command" | "cwd">
    >;
  };
} {
  const { deepSnapshot, ...summary } = sample;
  const publicSummary = {
    ...summary,
    hostCpuPct: sample.hostCpuStatus === "unavailable" ? null : sample.hostCpuPct,
  };
  if (deepSnapshot === undefined) return publicSummary;
  return {
    ...publicSummary,
    deepSnapshot: {
      capturedAt: deepSnapshot.capturedAt,
      thermal: deepSnapshot.thermal,
      processes: deepSnapshot.processes.map(
        ({ command: _command, cwd: _cwd, ...process }) => process,
      ),
    },
  };
}

type PublicResourceSample = ReturnType<typeof publicSample>;
type PublicResourceView = Omit<ResourceGuardianView, "latestSample"> & {
  latestSample: PublicResourceSample | null;
};

function publicView(
  view: ResourceGuardianView,
  preferences: Pick<ResourceGuardianOperatorState, "mode" | "profile">,
): PublicResourceView {
  return {
    ...view,
    mode: preferences.mode,
    profile: preferences.profile,
    reason: sanitizeResourceGuardianText(view.reason),
    latestSample: view.latestSample === null ? null : publicSample(view.latestSample),
    sampling: {
      ...view.sampling,
      lastError:
        view.sampling.lastError === null
          ? null
          : sanitizeResourceGuardianText(view.sampling.lastError),
    },
  };
}

function publicIncident(incident: ResourceIncident): unknown {
  return {
    ...incident,
    samples: incident.samples.map(publicSample),
    transitions: incident.transitions.map((transition) => ({
      ...transition,
      reason: sanitizeResourceGuardianText(transition.reason),
    })),
    actions: incident.actions.map((action) => ({
      ...action,
      reason: sanitizeResourceGuardianText(action.reason),
    })),
  };
}

function output(value: unknown, json: boolean): string {
  if (json) return JSON.stringify(tildeifyHomeDeep(value), null, 2);
  if (typeof value === "string") return tildeifyHome(value);
  return JSON.stringify(tildeifyHomeDeep(value), null, 2);
}

function parseIncidentArgs(args: string[]): { json: boolean; limit: number } | string {
  let limit = DEFAULT_INCIDENT_LIMIT;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--limit") {
      const parsed = Number(args[index + 1]);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_INCIDENT_LIMIT)
        return `--limit must be an integer from 1 to ${MAX_INCIDENT_LIMIT}`;
      limit = parsed;
      index += 1;
      continue;
    }
    return `unknown option "${arg}"`;
  }
  return { json, limit };
}

type ResourceGuardianCommandDependencies = {
  store?: ResourceGuardianStore;
  readEnvironment?: () => Map<string, string>;
  writeEnvironment?: (values: Record<string, string>) => void;
};

function writeMatchedOperatorOverride(input: {
  key: "RESOURCE_GUARDIAN_MODE" | "RESOURCE_GUARDIAN_PROFILE";
  value: string;
  store: ResourceGuardianStore;
  readEnvironment(): Map<string, string>;
  writeEnvironment(values: Record<string, string>): void;
}): ResourceGuardianOperatorState {
  return writeResourceGuardianOperatorUpdate({ ...input, now: Date.now() });
}

/** Dedicated, non-secret Resource Guardian inspection and operator override surface. */
export function runResourceGuardianCommand(
  args: string[],
  dependencies: ResourceGuardianCommandDependencies = {},
): CommandResult {
  const [action, value, ...rest] = args;
  try {
    const store = dependencies.store ?? createResourceGuardianStore({ stateDir: appStateDir() });
    const readEnvironment = dependencies.readEnvironment ?? readConfigEnvironment;
    const writeEnvironment = dependencies.writeEnvironment ?? writeConfigEnvironment;
    const env = readEnvironment();
    if (action === "status") {
      const json = jsonOption(
        [value, ...rest].filter((entry): entry is string => entry !== undefined),
      );
      if (typeof json === "string") return { exitCode: 1, stderr: json };
      const current = store.readCurrentReadOnly();
      const view = publicView(current.view, {
        mode: configuredMode(env),
        profile: configuredProfile(env),
      });
      const configuredTickMs = tickMs(env);
      const result = {
        enabled: enabled(env) && configuredTickMs > 0,
        tickMs: configuredTickMs,
        view,
        ...(current.degraded ? { degraded: true } : {}),
      };
      const text = [
        `Resource Guardian: ${result.enabled ? "enabled" : "disabled"} · tick ${result.tickMs}ms`,
        `Pressure: ${current.view.pressure} · ${current.view.circuit}`,
        `Mode: ${view.mode} · Profile: ${view.profile}`,
        `Incident: ${current.view.incidentId ?? "none"}`,
        `Reason: ${sanitizeResourceGuardianText(current.view.reason)}`,
        `Attribution: ${current.view.attribution}`,
      ].join("\n");
      return { exitCode: 0, stdout: json ? output(result, true) : output(text, false) };
    }
    if (action === "incidents") {
      const parsed = parseIncidentArgs(
        [value, ...rest].filter((entry): entry is string => entry !== undefined),
      );
      if (typeof parsed === "string") return { exitCode: 1, stderr: parsed };
      const incidents = store
        .listIncidents()
        .sort(
          (left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt),
        )
        .slice(0, parsed.limit);
      const text =
        incidents.length === 0
          ? "Resource Guardian incidents: none"
          : incidents
              .map((incident) => `${incident.id} · ${incident.pressure} · ${incident.attribution}`)
              .join("\n");
      return {
        exitCode: 0,
        stdout: parsed.json ? output(incidents.map(publicIncident), true) : output(text, false),
      };
    }
    if (action === "mode") {
      const json = jsonOption(rest);
      if (typeof json === "string") return { exitCode: 1, stderr: json };
      if (value === undefined || !modes.has(value as ResourceGuardianMode)) {
        return { exitCode: 1, stderr: "Usage: resource mode observe|protect [--json]" };
      }
      const mode = value as ResourceGuardianMode;
      const current = store.readCurrentReadOnly();
      if (mode === "protect" && (!enabled(env) || tickMs(env) === 0 || !current.view.enabled)) {
        return {
          exitCode: 1,
          stderr:
            "Resource Guardian protect mode requires a running enabled Guardian with a positive tick; use config set RESOURCE_GUARDIAN_ENABLED true and restart the service before enabling protection",
        };
      }
      const operator = writeMatchedOperatorOverride({
        key: "RESOURCE_GUARDIAN_MODE",
        value: mode,
        store,
        readEnvironment,
        writeEnvironment,
      });
      const result = { mode, profile: operator.profile };
      return {
        exitCode: 0,
        stdout: json ? output(result, true) : `Resource Guardian mode: ${mode}`,
      };
    }
    if (action === "profile") {
      const json = jsonOption(rest);
      if (typeof json === "string") return { exitCode: 1, stderr: json };
      if (value === undefined || !profiles.has(value as ResourceGuardianProfile)) {
        return { exitCode: 1, stderr: "Usage: resource profile balanced|conservative [--json]" };
      }
      const profile = value as ResourceGuardianProfile;
      const operator = writeMatchedOperatorOverride({
        key: "RESOURCE_GUARDIAN_PROFILE",
        value: profile,
        store,
        readEnvironment,
        writeEnvironment,
      });
      const result = { mode: operator.mode, profile };
      return {
        exitCode: 0,
        stdout: json ? output(result, true) : `Resource Guardian profile: ${profile}`,
      };
    }
    return {
      exitCode: 1,
      stderr:
        "Usage: resource status [--json] | incidents [--limit N] [--json] | mode observe|protect [--json] | profile balanced|conservative [--json]",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stderr: sanitizeResourceGuardianText(error instanceof Error ? error.message : String(error)),
    };
  }
}
