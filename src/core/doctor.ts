import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseEnv, validateTokenShape } from "./onboarding.js";

/**
 * Health checks for an installed bot, shared by the `npm run doctor` CLI and
 * the `/doctor` chat command. System access goes through {@link DoctorProbes}
 * so checks are unit-testable; renderers decide presentation — the chat one
 * is redacted (no app ids), the CLI one keeps full detail.
 */

export const LAUNCHD_LABEL = "com.octopusgarage.tmux-claude-bot";

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
  launchdLoaded(): Promise<boolean>;
  botProcessCount(): Promise<number>;
  fileExists(path: string): boolean;
}

const run = promisify(execFile);

export function defaultProbes(root: string = process.cwd()): DoctorProbes {
  return {
    readEnv: () => {
      const envPath = join(root, ".env");
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
    launchdLoaded: async () => {
      try {
        await run("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`]);
        return true;
      } catch {
        return false;
      }
    },
    botProcessCount: async () => {
      try {
        const { stdout } = await run("pgrep", [
          "-f",
          "tmux-claude-bot.*(src/index.ts|dist/cli.js)",
        ]);
        return stdout.split("\n").filter((l) => l.trim()).length;
      } catch {
        return 0; // pgrep exits 1 when there are no matches
      }
    },
    fileExists: (p) => existsSync(p),
  };
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
  else bad("tmux not found", "brew install tmux");
  if (await probes.onPath("node")) ok("node is on PATH");
  else bad("node not found", "install Node via nvm: https://github.com/nvm-sh/nvm");

  // 3. launchd agent
  if (await probes.launchdLoaded()) ok(`launchd agent ${LAUNCHD_LABEL} is loaded`);
  else bad(`launchd agent ${LAUNCHD_LABEL} not loaded`, "run: npm run service:install");

  // 4. single-instance (the 409 trap)
  const n = await probes.botProcessCount();
  if (n === 1) ok("exactly one bot process is running");
  else if (n === 0)
    bad("no bot process running", `launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`);
  else
    bad(
      `${n} bot processes running (409 conflict risk)`,
      `more than one instance (409 risk). Kill the stray non-launchd PIDs (PPID != 1), then: launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`,
    );

  // 5. optional voice transcription (mlx_whisper). Not configured == not a failure.
  const mlxBin = envMap?.get("MLX_WHISPER_BIN") ?? "";
  const langPref = envMap?.get("WHISPER_LANGUAGE") || "zh";
  if (!mlxBin) {
    info("voice transcription disabled (MLX_WHISPER_BIN empty; npm run whisper:install)");
  } else if (probes.fileExists(mlxBin)) {
    ok(`voice: MLX_WHISPER_BIN points to an existing binary (language ${langPref})`);
  } else {
    bad("voice: MLX_WHISPER_BIN set but binary is missing", "run: npm run whisper:install");
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
