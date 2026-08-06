import { existsSync, readFileSync } from "node:fs";
import { appStateFile } from "../../shared/state-dir.js";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";
import { parseEnv, serializeEnv } from "../infra/onboarding.js";

type CommandResult =
  | { exitCode: number; stdout: string; stderr?: never }
  | { exitCode: number; stderr: string; stdout?: never };

type ConfigEntry = {
  key: string;
  value: string;
  secret: boolean;
  settable: boolean;
};

type AutomationId = "loop" | "task-audit" | "runtime-guardian" | "batch";

type AutomationSpec = {
  id: AutomationId;
  label: string;
  enableKey?: string;
  tickKey: string;
  defaultTickMs: string;
  configuredKey?: string;
  dependencyKeys?: string[];
};

type AutomationStatus = {
  id: AutomationId;
  label: string;
  enabled: boolean;
  configured: boolean;
  tickMs: number;
  keys: string[];
  dependencies?: Record<string, boolean>;
};

const SECRET_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE|WEBHOOK)/i;

const CONFIG_SETTABLE_KEYS = new Set([
  "UI_LANG",
  "TELEGRAM_UI_LANG",
  "LARK_UI_LANG",
  "WHISPER_LANGUAGE",
  "TELEGRAM_WHISPER_LANGUAGE",
  "LARK_WHISPER_LANGUAGE",
  "PROMPT_TRANSLATE_MODE",
  "PROMPT_TRANSLATE_FROM",
  "PROMPT_TRANSLATE_TO",
  "CONTROL_PROMPT_TRANSLATE_MODE",
  "CONTROL_PROMPT_TRANSLATE_FROM",
  "CONTROL_PROMPT_TRANSLATE_TO",
  "CD_ALLOWED_DIRS",
  "CLAUDE_START_COMMAND",
  "CODEX_START_COMMAND",
  "HOME_OPERATOR_ENABLED",
  "HOME_OPERATOR_AGENT",
  "HOME_OPERATOR_DIR",
  "TCB_KEEP_AWAKE",
  "AUTO_RECOVER",
  "LOOP_ENGINEERING_CONFIG_FILE",
  "LOOP_ENGINEERING_TICK_MS",
  "LOOP_SUPERVISOR_ENABLED",
  "TASK_AUDIT_ENABLED",
  "TASK_AUDIT_TICK_MS",
  "RUNTIME_GUARDIAN_ENABLED",
  "RUNTIME_GUARDIAN_TICK_MS",
  "BATCH_SCHEDULER_TICK_MS",
]);

const AUTOMATIONS: AutomationSpec[] = [
  {
    id: "loop",
    label: "Loop Engineering",
    tickKey: "LOOP_ENGINEERING_TICK_MS",
    defaultTickMs: "300000",
    configuredKey: "LOOP_ENGINEERING_CONFIG_FILE",
    dependencyKeys: ["LOOP_SUPERVISOR_ENABLED"],
  },
  {
    id: "task-audit",
    label: "Daily Task Audit",
    enableKey: "TASK_AUDIT_ENABLED",
    tickKey: "TASK_AUDIT_TICK_MS",
    defaultTickMs: "300000",
  },
  {
    id: "runtime-guardian",
    label: "Runtime Guardian",
    enableKey: "RUNTIME_GUARDIAN_ENABLED",
    tickKey: "RUNTIME_GUARDIAN_TICK_MS",
    defaultTickMs: "120000",
  },
  {
    id: "batch",
    label: "Batch Scheduler",
    tickKey: "BATCH_SCHEDULER_TICK_MS",
    defaultTickMs: "8000",
  },
];

function envPath(): string {
  return appStateFile(".env");
}

function pauseStatePath(): string {
  return appStateFile("automation-pauses.json");
}

function readEnvText(): string {
  const path = envPath();
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function readEnvMap(): Map<string, string> {
  return parseEnv(readEnvText());
}

function writeEnvValues(values: Record<string, string>): void {
  writeFileAtomicSync(envPath(), serializeEnv(readEnvText(), values), { mode: 0o600 });
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function redactedValue(key: string, value: string): string {
  if (!isSecretKey(key)) return value;
  return value.trim() === "" ? "" : "<redacted>";
}

function configEntries(env = readEnvMap()): ConfigEntry[] {
  return [...env.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({
      key,
      value: redactedValue(key, value),
      secret: isSecretKey(key),
      settable: CONFIG_SETTABLE_KEYS.has(key) && !isSecretKey(key),
    }));
}

function jsonFlag(args: string[]): boolean | string {
  for (const arg of args) {
    if (arg !== "--json") return `unknown option "${arg}"`;
  }
  return args.includes("--json");
}

function renderConfigList(entries: ConfigEntry[]): string {
  if (entries.length === 0) return "config: no .env entries";
  return [
    `config: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
    ...entries.map((entry) => {
      const flags = [entry.secret ? "secret" : "plain", entry.settable ? "settable" : "readonly"];
      return `- ${entry.key}=${entry.value} (${flags.join(",")})`;
    }),
  ].join("\n");
}

function normalizeBoolean(value: string): string {
  const lower = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(lower)) return "true";
  if (["0", "false", "no", "off"].includes(lower)) return "false";
  return value;
}

export function runConfigCommand(args: string[]): CommandResult {
  const [action, key, value, ...rest] = args;
  try {
    if (action === "list") {
      const json = jsonFlag(args.slice(1));
      if (typeof json === "string") return { exitCode: 1, stderr: json };
      const entries = configEntries();
      return { exitCode: 0, stdout: json ? JSON.stringify(entries) : renderConfigList(entries) };
    }
    if (action === "get") {
      if (key === undefined) return { exitCode: 1, stderr: "Usage: config get <key> [--json]" };
      const json = jsonFlag(args.slice(2));
      if (typeof json === "string") return { exitCode: 1, stderr: json };
      const env = readEnvMap();
      const raw = env.get(key) ?? "";
      const entry = {
        key,
        value: redactedValue(key, raw),
        secret: isSecretKey(key),
        settable: CONFIG_SETTABLE_KEYS.has(key) && !isSecretKey(key),
        present: env.has(key),
      };
      return { exitCode: 0, stdout: json ? JSON.stringify(entry) : `${key}=${entry.value}` };
    }
    if (action === "set") {
      if (key === undefined || value === undefined) {
        return { exitCode: 1, stderr: "Usage: config set <key> <value> [--json]" };
      }
      const json = jsonFlag(rest);
      if (typeof json === "string") return { exitCode: 1, stderr: json };
      if (!CONFIG_SETTABLE_KEYS.has(key) || isSecretKey(key)) {
        return {
          exitCode: 1,
          stderr: `${key} is not settable through generic config; use setup or a dedicated command`,
        };
      }
      const env = readEnvMap();
      const normalized = normalizeBoolean(value);
      const changed = env.get(key) !== normalized;
      if (changed) writeEnvValues({ [key]: normalized });
      const result = { key, value: normalized, changed };
      return {
        exitCode: 0,
        stdout: json
          ? JSON.stringify(result)
          : `config set: ${key} ${changed ? "updated" : "unchanged"}`,
      };
    }
    return {
      exitCode: 1,
      stderr:
        "Usage: config list [--json] | config get <key> [--json] | config set <key> <value> [--json]",
    };
  } catch (err) {
    return { exitCode: 1, stderr: err instanceof Error ? err.message : String(err) };
  }
}

function parseIntValue(value: string | undefined, fallback: string): number {
  const raw = value === undefined || value.trim() === "" ? fallback : value;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.parseInt(fallback, 10);
}

function boolEnabled(value: string | undefined, fallback = "false"): boolean {
  const raw = (value === undefined || value.trim() === "" ? fallback : value).trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "no" && raw !== "off";
}

function automationStatusFor(spec: AutomationSpec, env: Map<string, string>): AutomationStatus {
  const tickMs = parseIntValue(env.get(spec.tickKey), spec.defaultTickMs);
  const configured =
    spec.configuredKey === undefined ? true : (env.get(spec.configuredKey)?.trim() ?? "") !== "";
  const familyEnabled = spec.enableKey === undefined ? true : boolEnabled(env.get(spec.enableKey));
  return {
    id: spec.id,
    label: spec.label,
    enabled: configured && familyEnabled && tickMs > 0,
    configured,
    tickMs,
    keys: [spec.tickKey, spec.enableKey, spec.configuredKey].filter(
      (candidate): candidate is string => candidate !== undefined,
    ),
    ...(spec.dependencyKeys === undefined
      ? {}
      : {
          dependencies: Object.fromEntries(
            spec.dependencyKeys.map((key) => [key, boolEnabled(env.get(key))]),
          ),
        }),
  };
}

function readPauseState(): Record<string, Record<string, string>> {
  const path = pauseStatePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, Record<string, string>>)
      : {};
  } catch {
    return {};
  }
}

function writePauseState(state: Record<string, Record<string, string>>): void {
  writeFileAtomicSync(pauseStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

function findAutomation(id: string | undefined): AutomationSpec | string {
  if (id === undefined)
    return "Usage: automation <pause|resume> <loop|task-audit|runtime-guardian|batch> [--json]";
  return AUTOMATIONS.find((spec) => spec.id === id) ?? `unknown automation target "${id}"`;
}

function renderAutomationStatus(statuses: AutomationStatus[]): string {
  return [
    `automation: ${statuses.length} target${statuses.length === 1 ? "" : "s"}`,
    ...statuses.map(
      (status) =>
        `- ${status.id}: ${status.enabled ? "enabled" : "disabled"} tickMs=${status.tickMs} configured=${status.configured}${
          status.dependencies === undefined
            ? ""
            : ` dependencies=${Object.entries(status.dependencies)
                .map(([key, enabled]) => `${key}:${enabled ? "enabled" : "disabled"}`)
                .join(",")}`
        }`,
    ),
  ].join("\n");
}

function toggleAutomation(
  spec: AutomationSpec,
  enabled: boolean,
): { status: AutomationStatus; changed: boolean } {
  const env = readEnvMap();
  const before = automationStatusFor(spec, env);
  const pauseState = readPauseState();
  const values: Record<string, string> = {};

  if (enabled) {
    const previous = pauseState[spec.id] ?? {};
    values[spec.tickKey] = previous[spec.tickKey] ?? spec.defaultTickMs;
    if (spec.enableKey !== undefined) values[spec.enableKey] = previous[spec.enableKey] ?? "true";
    delete pauseState[spec.id];
  } else {
    pauseState[spec.id] = {
      [spec.tickKey]: env.get(spec.tickKey) ?? spec.defaultTickMs,
      ...(spec.enableKey !== undefined
        ? { [spec.enableKey]: env.get(spec.enableKey) ?? "true" }
        : {}),
    };
    values[spec.tickKey] = "0";
    if (spec.enableKey !== undefined) values[spec.enableKey] = "false";
  }

  writeEnvValues(values);
  writePauseState(pauseState);
  const after = automationStatusFor(spec, readEnvMap());
  return {
    status: after,
    changed: before.enabled !== after.enabled || before.tickMs !== after.tickMs,
  };
}

export function runAutomationCommand(args: string[]): CommandResult {
  const [action, id, ...rest] = args;
  try {
    if (action === "status") {
      const json = jsonFlag(args.slice(1));
      if (typeof json === "string") return { exitCode: 1, stderr: json };
      const env = readEnvMap();
      const statuses = AUTOMATIONS.map((spec) => automationStatusFor(spec, env));
      return {
        exitCode: 0,
        stdout: json ? JSON.stringify(statuses) : renderAutomationStatus(statuses),
      };
    }
    if (action === "pause" || action === "resume") {
      const json = jsonFlag(rest);
      if (typeof json === "string") return { exitCode: 1, stderr: json };
      const spec = findAutomation(id);
      if (typeof spec === "string") return { exitCode: 1, stderr: spec };
      const result = toggleAutomation(spec, action === "resume");
      const out = { ...result.status, changed: result.changed };
      return {
        exitCode: 0,
        stdout: json
          ? JSON.stringify(out)
          : `automation ${action}: ${spec.id} ${result.changed ? "updated" : "unchanged"}`,
      };
    }
    return {
      exitCode: 1,
      stderr:
        "Usage: automation status [--json] | automation pause <loop|task-audit|runtime-guardian|batch> [--json] | automation resume <loop|task-audit|runtime-guardian|batch> [--json]",
    };
  } catch (err) {
    return { exitCode: 1, stderr: err instanceof Error ? err.message : String(err) };
  }
}
