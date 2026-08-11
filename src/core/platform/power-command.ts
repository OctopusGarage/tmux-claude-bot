import { loadConfig } from "../../shared/config.js";
import type { HostPowerConfig } from "../../shared/types.js";
import { resolveHostPowerPhase, wakeTimeFor } from "./power-policy.js";
import {
  createPowerScheduleProbe,
  inspectPowerSchedule,
  type PowerScheduleProbe,
} from "./power-schedule.js";

type CommandResult =
  | { exitCode: number; stdout: string; stderr?: never }
  | { exitCode: number; stderr: string; stdout?: never };

type PowerCommandOptions = {
  config?: HostPowerConfig;
  now?: () => number;
  probe?: PowerScheduleProbe;
};

function commandError(error: unknown): CommandResult {
  return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
}

function statusResult(
  config: HostPowerConfig,
  now: number,
  probe: PowerScheduleProbe,
  json: boolean,
): CommandResult {
  const phase = resolveHostPowerPhase(config, now);
  const schedule = inspectPowerSchedule(config, probe);
  const view = {
    mode: config.mode,
    phase,
    timezone: config.timezone,
    quietStart: config.quietStart,
    wakeAt: wakeTimeFor(config),
    quietEnd: config.quietEnd,
    keepAwakeExpected:
      config.mode === "always" ||
      (config.mode === "scheduled" && (phase === "service" || phase === "wake-warmup")),
    schedule,
  };
  return {
    exitCode: 0,
    stdout: json
      ? JSON.stringify(view)
      : [
          `power: mode=${view.mode} phase=${view.phase} timezone=${view.timezone}`,
          `window: quiet=${view.quietStart} wake=${view.wakeAt} resume=${view.quietEnd}`,
          `keep-awake: ${view.keepAwakeExpected ? "expected" : "released"}`,
          `wake schedule: ${schedule.status} (${schedule.detail})`,
        ].join("\n"),
  };
}

function requireScheduled(config: HostPowerConfig): CommandResult | null {
  return config.mode === "scheduled"
    ? null
    : { exitCode: 1, stderr: "power schedule mutation requires TCB_KEEP_AWAKE_MODE=scheduled" };
}

function installSchedule(config: HostPowerConfig, probe: PowerScheduleProbe): CommandResult {
  const invalidMode = requireScheduled(config);
  if (invalidMode) return invalidMode;
  const before = inspectPowerSchedule(config, probe);
  if (before.status === "verified") {
    return { exitCode: 0, stdout: "power schedule install: unchanged" };
  }
  if (before.status !== "missing") {
    return {
      exitCode: 1,
      stderr: `power schedule install refused: ${before.status}: ${before.detail}`,
    };
  }
  try {
    probe.runPrivileged(["repeat", "wake", "MTWRFSU", `${before.wakeAt}:00`]);
  } catch (error) {
    return commandError(error);
  }
  const after = inspectPowerSchedule(config, probe);
  return after.status === "verified"
    ? { exitCode: 0, stdout: `power schedule install: wake daily at ${after.wakeAt}` }
    : {
        exitCode: 1,
        stderr: `power schedule install could not be verified: ${after.status}: ${after.detail}`,
      };
}

function removeSchedule(config: HostPowerConfig, probe: PowerScheduleProbe): CommandResult {
  const invalidMode = requireScheduled(config);
  if (invalidMode) return invalidMode;
  const before = inspectPowerSchedule(config, probe);
  if (before.status === "missing") {
    return { exitCode: 0, stdout: "power schedule remove: unchanged" };
  }
  if (before.status !== "verified") {
    return {
      exitCode: 1,
      stderr: `power schedule remove refused: ${before.status}: ${before.detail}`,
    };
  }
  try {
    probe.runPrivileged(["repeat", "cancel"]);
  } catch (error) {
    return commandError(error);
  }
  const after = inspectPowerSchedule(config, probe);
  return after.status === "missing"
    ? { exitCode: 0, stdout: "power schedule remove: removed" }
    : {
        exitCode: 1,
        stderr: `power schedule removal could not be verified: ${after.status}: ${after.detail}`,
      };
}

export function runPowerCommand(args: string[], options: PowerCommandOptions = {}): CommandResult {
  const config = options.config ?? loadConfig().hostPower;
  const probe = options.probe ?? createPowerScheduleProbe();
  const [action, subcommand, ...rest] = args;
  if (action === "status") {
    if (rest.length > 0 || (subcommand !== undefined && subcommand !== "--json")) {
      return { exitCode: 1, stderr: "Usage: power status [--json]" };
    }
    return statusResult(config, (options.now ?? Date.now)(), probe, subcommand === "--json");
  }
  if (action === "schedule" && rest.length === 0) {
    if (subcommand === "install") return installSchedule(config, probe);
    if (subcommand === "remove") return removeSchedule(config, probe);
  }
  return {
    exitCode: 1,
    stderr: "Usage: power status [--json] | power schedule <install|remove>",
  };
}
