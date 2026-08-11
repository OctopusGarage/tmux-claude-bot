import { isUiLang } from "../i18n/index.js";
import { readConfigEnvironment, writeConfigEnvironment } from "./env-store.js";

type CommandResult =
  | { exitCode: number; stdout: string; stderr?: never }
  | { exitCode: number; stderr: string; stdout?: never };

type ConfigEntry = {
  key: string;
  value: string;
  secret: boolean;
  settable: boolean;
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
  "RESOURCE_GUARDIAN_ENABLED",
  "RESOURCE_GUARDIAN_TICK_MS",
]);

const BOOLEAN_KEYS = new Set([
  "HOME_OPERATOR_ENABLED",
  "TCB_KEEP_AWAKE",
  "AUTO_RECOVER",
  "LOOP_SUPERVISOR_ENABLED",
  "TASK_AUDIT_ENABLED",
  "RUNTIME_GUARDIAN_ENABLED",
  "RESOURCE_GUARDIAN_ENABLED",
]);

const NON_NEGATIVE_INTEGER_KEYS = new Set([
  "LOOP_ENGINEERING_TICK_MS",
  "TASK_AUDIT_TICK_MS",
  "RUNTIME_GUARDIAN_TICK_MS",
  "BATCH_SCHEDULER_TICK_MS",
  "RESOURCE_GUARDIAN_TICK_MS",
]);

const UI_LANGUAGE_KEYS = new Set(["UI_LANG", "TELEGRAM_UI_LANG", "LARK_UI_LANG"]);
const PROMPT_TRANSLATE_MODE_KEYS = new Set([
  "PROMPT_TRANSLATE_MODE",
  "CONTROL_PROMPT_TRANSLATE_MODE",
]);

function readEnvMap(): Map<string, string> {
  return readConfigEnvironment();
}

function writeEnvValues(values: Record<string, string>): void {
  writeConfigEnvironment(values);
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

function normalizeSettableValue(key: string, value: string): string | { error: string } {
  if (BOOLEAN_KEYS.has(key)) {
    const normalized = normalizeBoolean(value);
    return normalized === "true" || normalized === "false"
      ? normalized
      : { error: `${key} must be true or false` };
  }
  if (NON_NEGATIVE_INTEGER_KEYS.has(key)) {
    const normalized = Number(value.trim());
    return value.trim() !== "" && Number.isSafeInteger(normalized) && normalized >= 0
      ? String(normalized)
      : { error: `${key} must be a non-negative integer` };
  }
  if (key === "HOME_OPERATOR_AGENT") {
    return value === "claude" || value === "codex"
      ? value
      : { error: `${key} must be claude or codex` };
  }
  if (UI_LANGUAGE_KEYS.has(key)) {
    return value === "" || isUiLang(value)
      ? value
      : { error: `${key} must be a supported UI language or blank` };
  }
  if (PROMPT_TRANSLATE_MODE_KEYS.has(key)) {
    return value === "" || value === "off" || value === "argos" || value === "argos_zh_en"
      ? value
      : { error: `${key} must be off, argos, argos_zh_en, or blank` };
  }
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
      const normalizedResult = normalizeSettableValue(key, value);
      if (typeof normalizedResult !== "string") {
        return { exitCode: 1, stderr: normalizedResult.error };
      }
      const normalized = normalizedResult;
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
