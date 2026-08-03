import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { appStateFile } from "../../shared/state-dir.js";
import {
  defaultOperatorHomeAiToolFiles,
  homeOperatorSkillFiles,
} from "../ai-tools/install-contract.js";
import { MCP_PROFILES, mcpProfilePath } from "../mcp/profiles.js";
import {
  managedRestartCommand,
  managedServiceLoadedProbe,
  managedServiceName,
  tmuxInstallHint,
} from "../platform/service-hints.js";
import {
  promptTranslationReadiness,
  voiceTranscriptionReadiness,
} from "../read/capability-readiness.js";
import { ARGOS_VENV_PYTHON, resolvePromptTranslateConfig } from "../read/prompt-translation.js";
import { WHISPER_VENV_BIN } from "../read/voice-support.js";
import { parseEnv, validateTokenShape } from "./onboarding.js";

/**
 * Health checks for an installed bot, shared by the `npm run doctor` CLI and
 * the `/doctor` chat command. System access goes through {@link DoctorProbes}
 * so checks are unit-testable; renderers decide presentation — the chat one
 * is redacted (no app ids), the CLI one keeps full detail.
 */

export interface DoctorCheck {
  status: "ok" | "bad" | "info";
  text: string;
  /** Suggested remedy, present iff status is "bad". */
  fix?: string;
  /** Extra detail safe for the local CLI but not for chat (e.g. app id). */
  sensitiveDetail?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  failures: number;
}

export interface DoctorProbes {
  /** Parsed .env, or null when the file doesn't exist. */
  readEnv(): Map<string, string> | null;
  onPath(bin: string): Promise<boolean>;
  /** Whether the managed service (launchd/systemd) is loaded. */
  serviceLoaded(): Promise<boolean>;
  botProcessCount(): Promise<number>;
  /** macOS: whether the bot's keep-awake caffeinate is live RIGHT NOW. Matches the
   * bot's unique `caffeinate -s -w` signature. */
  caffeinateActive(): Promise<boolean>;
  /** macOS: lid (clamshell) state — true=closed, false=open, null=no laptop lid. */
  clamshellClosed(): Promise<boolean | null>;
  /** macOS: whether `pmset disablesleep` is engaged (covers a closed lid). */
  sleepDisabled(): Promise<boolean>;
  fileExists(path: string): boolean;
}

const run = promisify(execFile);

export function defaultProbes(root: string = process.cwd()): DoctorProbes {
  return {
    readEnv: () => {
      // `.env` lives in the state dir; fall back to the legacy install-root path
      // for a not-yet-migrated install.
      const envPath = existsSync(appStateFile(".env")) ? appStateFile(".env") : join(root, ".env");
      return existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : null;
    },
    onPath: async (bin) => {
      try {
        await run("/bin/sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", bin]);
        return true;
      } catch {
        return false;
      }
    },
    serviceLoaded: async () => {
      try {
        const { cmd, args } = managedServiceLoadedProbe();
        await run(cmd, args);
        return true;
      } catch {
        return false;
      }
    },
    botProcessCount: async () => {
      try {
        const { stdout } = await run("ps", ["-axo", "pid=,ppid=,command="]);
        return countBotProcessRoots(stdout);
      } catch {
        return 0;
      }
    },
    caffeinateActive: async () => {
      try {
        await run("pgrep", ["-f", "caffeinate -s -w"]);
        return true;
      } catch {
        return false; // pgrep exits 1 when there are no matches
      }
    },
    clamshellClosed: async () => {
      try {
        const { stdout } = await run("ioreg", ["-r", "-k", "AppleClamshellState"]);
        const m = stdout.match(/"AppleClamshellState"\s*=\s*(Yes|No)/);
        return m ? m[1] === "Yes" : null; // no key → desktop / no lid
      } catch {
        return null;
      }
    },
    sleepDisabled: async () => {
      try {
        const { stdout } = await run("pmset", ["-g"]);
        return /\bSleepDisabled\s+1\b/.test(stdout);
      } catch {
        return false;
      }
    },
    fileExists: (p) => existsSync(p),
  };
}

export function countBotProcessRoots(psOutput: string): number {
  const rows = psOutput
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (match === null) return [];
      const [, pid, ppid, command] = match;
      if (pid === undefined || ppid === undefined || command === undefined) return [];
      return [{ pid, ppid, command }];
    })
    .filter((row) => /tmux-claude-bot.*(src\/index\.ts|dist\/cli\.js)/.test(row.command));
  const matchedPids = new Set(rows.map((row) => row.pid));
  return rows.filter((row) => !matchedPids.has(row.ppid)).length;
}

export async function runDoctorChecks(probes: DoctorProbes): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const ok = (text: string, sensitiveDetail?: string) =>
    checks.push(sensitiveDetail ? { status: "ok", text, sensitiveDetail } : { status: "ok", text });
  const info = (text: string) => checks.push({ status: "info", text });
  const bad = (text: string, fix: string) => checks.push({ status: "bad", text, fix });

  // 1. .env + at least one chat adapter (Telegram via TELEGRAM_BOT_TOKEN, Feishu via LARK_*)
  const envMap = probes.readEnv();
  if (!envMap) {
    bad("no .env found", "run: npm run setup");
  } else {
    const token = envMap.get("TELEGRAM_BOT_TOKEN") ?? envMap.get("BOT_TOKEN") ?? "";
    const telegram = validateTokenShape(token);
    const lark =
      envMap.get("LARK_ENABLED") === "true" &&
      Boolean(envMap.get("LARK_APP_ID")) &&
      Boolean(envMap.get("LARK_APP_SECRET"));

    if (telegram) ok("Telegram configured (well-formed TELEGRAM_BOT_TOKEN)");
    else if (token)
      bad("TELEGRAM_BOT_TOKEN is set but looks invalid", "run: npm run setup:reconfigure");
    else info("Telegram not configured (no TELEGRAM_BOT_TOKEN)");

    if (lark) ok("Feishu/Lark configured", `app ${envMap.get("LARK_APP_ID")}`);
    else info("Feishu/Lark not configured (run: npm run setup:lark)");

    if (!telegram && !lark) {
      bad("no chat adapter configured", "run: npm run setup  (choose Telegram, Feishu, or both)");
    }
  }

  // 2. tmux + node on PATH
  if (await probes.onPath("tmux")) ok("tmux is on PATH");
  else bad("tmux not found", tmuxInstallHint());
  if (await probes.onPath("node")) ok("node is on PATH");
  else bad("node not found", "install Node via nvm: https://github.com/nvm-sh/nvm");

  // 2b. Default AI tool surface installation. Managed installs should keep the
  // Home Operator skill and MCP descriptors in the operator workspace only. The
  // file list comes from the central role-surface contract so new role profiles
  // must be added to health checks in the same slice.
  const operatorHome = envMap?.get("HOME_OPERATOR_DIR") || appStateFile("home");
  const installedOperatorSkillFiles = homeOperatorSkillFiles(operatorHome).filter((file) =>
    probes.fileExists(file.path),
  );
  if (installedOperatorSkillFiles.length === homeOperatorSkillFiles(operatorHome).length) {
    ok("Home Operator skill installed in operator workspace");
  } else if (installedOperatorSkillFiles.length === 0) {
    bad(
      "Home Operator skill missing from operator workspace",
      "run: tcb skill install --scope operator-home",
    );
  } else {
    bad(
      `Home Operator skill partially installed (${installedOperatorSkillFiles
        .map((file) => file.client)
        .join(", ")})`,
      "run: tcb skill install --scope operator-home",
    );
  }

  const installedMcpProfiles = MCP_PROFILES.filter((profile) =>
    probes.fileExists(mcpProfilePath(operatorHome, profile)),
  );
  if (installedMcpProfiles.length === MCP_PROFILES.length) {
    ok(`MCP profiles installed (${installedMcpProfiles.join(", ")})`);
  } else if (installedMcpProfiles.length === 0) {
    info("MCP profiles not installed (run: tcb mcp install)");
  } else {
    bad(
      `MCP profiles partially installed (${installedMcpProfiles.join(", ")})`,
      "run: tcb mcp install",
    );
  }
  const expectedDefaultAiToolFiles = defaultOperatorHomeAiToolFiles(operatorHome);
  const installedDefaultAiToolFiles = expectedDefaultAiToolFiles.filter((file) =>
    probes.fileExists(file.path),
  );
  if (installedDefaultAiToolFiles.length === expectedDefaultAiToolFiles.length) {
    ok(
      `AI tool role surfaces complete (${installedDefaultAiToolFiles
        .map((file) =>
          file.surface === "mcp" ? `mcp:${file.profile ?? "unknown"}` : `skill:${file.client}`,
        )
        .join(", ")})`,
    );
  }

  // 3. managed service (launchd on macOS, systemd on Linux). Identity + restart
  // hint come from the single-source service-hints module.
  const serviceName = managedServiceName();
  const restartHint = managedRestartCommand();

  if (await probes.serviceLoaded()) ok(`${serviceName} is loaded`);
  else bad(`${serviceName} not loaded`, "run: npm run service:install");

  // 4. single-instance (the 409 trap)
  const n = await probes.botProcessCount();
  if (n === 1) ok("exactly one bot process is running");
  else if (n === 0) bad("no bot process running", restartHint);
  else
    bad(
      `${n} bot processes running (409 conflict risk)`,
      `more than one instance (409 risk). Kill the stray PIDs, then: ${restartHint}`,
    );

  const envObj = Object.fromEntries(envMap ?? []) as Record<string, string | undefined>;

  // 5. optional voice transcription (mlx_whisper). Not configured == not a failure.
  const mlxBin = envMap?.get("MLX_WHISPER_BIN") ?? "";
  const langPref = envMap?.get("WHISPER_LANGUAGE") || "zh";
  if (!mlxBin) {
    info("voice transcription disabled (MLX_WHISPER_BIN empty; npm run whisper:install)");
  } else {
    const voice = voiceTranscriptionReadiness({
      env: envObj,
      fallbackBin: WHISPER_VENV_BIN,
      platformSupported: true,
      probes: { pathExists: probes.fileExists },
    });
    if (voice.status === "ready") {
      ok(`voice: MLX_WHISPER_BIN points to an existing binary (language ${langPref})`);
    } else {
      bad(
        `voice: MLX_WHISPER_BIN set but binary is ${voice.status === "not-executable" ? "not executable" : "missing"}`,
        "run: npm run whisper:install",
      );
    }
  }

  // 6. optional prompt translation (Argos Translate). Not enabled == not a failure.
  const promptTranslateConfigs = [
    ["telegram", resolvePromptTranslateConfig("telegram", envObj)] as const,
    ["lark", resolvePromptTranslateConfig("lark", envObj)] as const,
    ["control", resolvePromptTranslateConfig("control", envObj)] as const,
  ].filter((entry) => entry[1].enabled);
  if (promptTranslateConfigs.length > 0) {
    const argos = promptTranslationReadiness({
      env: envObj,
      fallbackPython: ARGOS_VENV_PYTHON,
      probes: { pathExists: probes.fileExists },
    });
    if (argos.status === "ready") {
      for (const [channel, cfg] of promptTranslateConfigs) {
        if (cfg.enabled) {
          ok(`prompt translation: ${channel} argos ${cfg.from}->${cfg.to} python is configured`);
        }
      }
    } else {
      for (const [channel, cfg] of promptTranslateConfigs) {
        if (cfg.enabled) {
          bad(
            `prompt translation: ${channel} argos ${cfg.from}->${cfg.to} python is ${
              argos.status === "not-executable" ? "not executable" : "missing"
            }`,
            "run: npm run translate:install",
          );
        }
      }
    }
  } else {
    info("prompt translation disabled (PROMPT_TRANSLATE_MODE off)");
  }

  // 7. keep-awake (macOS only). Opt-in flag + a live probe of the bot's caffeinate
  // assertion, so this reports whether it's ACTUALLY asserting now, not just
  // whether the flag is set.
  if (process.platform === "darwin") {
    const keepAwake = envMap?.get("TCB_KEEP_AWAKE");
    if (keepAwake === "1" || keepAwake === "true") {
      if (await probes.caffeinateActive()) {
        ok("keep-awake on and active (caffeinate -s asserting on AC power)");
      } else {
        info(
          "keep-awake on but no caffeinate running — start/restart the bot to apply (it's the bot process that holds it)",
        );
      }

      // caffeinate -s does NOT cover a closed lid; only `pmset disablesleep`
      // does. Surface the real lid + disablesleep state so closing the lid
      // without disablesleep — which WILL sleep the Mac and drop the bot — is a
      // hard fail rather than a silent surprise.
      const closed = await probes.clamshellClosed();
      if (closed !== null) {
        if (await probes.sleepDisabled()) {
          ok(`lid ${closed ? "closed" : "open"}, clamshell sleep disabled (pmset disablesleep on)`);
        } else if (closed) {
          bad(
            "lid is CLOSED and clamshell sleep is not disabled — the Mac will sleep and drop the bot",
            "run: sudo pmset -a disablesleep 1   (or open the lid)",
          );
        } else {
          info(
            "lid open, but clamshell sleep is not disabled — closing the lid will sleep the Mac (sudo pmset -a disablesleep 1)",
          );
        }
      }
    } else {
      info("keep-awake off — the Mac may sleep and drop the bot (setup --reconfigure to enable)");
    }
  }

  return { checks, failures: checks.filter((c) => c.status === "bad").length };
}

const STATUS_ICON = { ok: "✅", bad: "❌", info: "ℹ️" } as const;

/**
 * Plain-text rendering for chat (and the data half of the CLI). With
 * `redacted: true`, sensitive details are dropped from the output.
 */
export function renderDoctorReport(report: DoctorReport, opts: { redacted: boolean }): string {
  const lines = report.checks.map((c) => {
    const detail = !opts.redacted && c.sensitiveDetail ? ` (${c.sensitiveDetail})` : "";
    const fix = c.fix ? `\n   fix: ${c.fix}` : "";
    return `${STATUS_ICON[c.status]} ${c.text}${detail}${fix}`;
  });
  const summary =
    report.failures === 0 ? "All checks passed." : `${report.failures} check(s) failed.`;
  return `${lines.join("\n")}\n\n${summary}`;
}
