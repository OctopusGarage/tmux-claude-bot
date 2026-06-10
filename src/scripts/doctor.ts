/**
 * Health check for an installed bot. Prints a ✓/✗ checklist and exits non-zero
 * if anything is wrong — notably MORE THAN ONE bot process (the documented 409
 * single-instance trap). Run via `npm run doctor`.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseEnv, validateTokenShape } from "../core/onboarding.js";

const run = promisify(execFile);
const ROOT = process.cwd();
const LABEL = "com.octopusgarage.tmux-claude-bot";

let failures = 0;
const ok = (s: string) => console.log(`\x1b[1;32m✓\x1b[0m ${s}`);
const info = (s: string) => console.log(`\x1b[1;34mi\x1b[0m ${s}`);
const bad = (s: string, fix: string) => {
  console.log(`\x1b[1;31m✗\x1b[0m ${s}\n   fix: ${fix}`);
  failures++;
};

async function onPath(bin: string): Promise<boolean> {
  try {
    await run("/bin/sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", bin]);
    return true;
  } catch {
    return false;
  }
}

async function botProcessCount(): Promise<number> {
  try {
    const { stdout } = await run("pgrep", ["-f", "tmux-claude-bot.*src/index.ts"]);
    return stdout.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0; // pgrep exits 1 when there are no matches
  }
}

async function launchdLoaded(): Promise<boolean> {
  try {
    await run("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // 1. .env + at least one chat adapter (Telegram via TELEGRAM_BOT_TOKEN, Feishu via LARK_*)
  const envPath = join(ROOT, ".env");
  const envMap = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : null;
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

    if (lark) ok(`Feishu/Lark configured (app ${envMap.get("LARK_APP_ID")})`);
    else info("Feishu/Lark not configured (run: npm run setup:lark)");

    if (!telegram && !lark) {
      bad("no chat adapter configured", "run: npm run setup  (choose Telegram, Feishu, or both)");
    }
  }

  // 2. tmux + node on PATH
  if (await onPath("tmux")) ok("tmux is on PATH");
  else bad("tmux not found", "brew install tmux");
  if (await onPath("node")) ok("node is on PATH");
  else bad("node not found", "install Node via nvm: https://github.com/nvm-sh/nvm");

  // 3. launchd agent
  if (await launchdLoaded()) ok(`launchd agent ${LABEL} is loaded`);
  else bad(`launchd agent ${LABEL} not loaded`, "run: npm run service:install");

  // 4. single-instance (the 409 trap)
  const n = await botProcessCount();
  if (n === 1) ok("exactly one bot process is running");
  else if (n === 0) bad("no bot process running", `launchctl kickstart -k gui/$(id -u)/${LABEL}`);
  else
    bad(
      `${n} bot processes running (409 conflict risk)`,
      `more than one instance (409 risk). Kill the stray non-launchd PIDs (PPID != 1), then: launchctl kickstart -k gui/$(id -u)/${LABEL}`,
    );

  // 5. optional voice transcription (mlx_whisper). Not configured == not a failure.
  const mlxBin = envMap?.get("MLX_WHISPER_BIN") ?? "";
  const langPref = envMap?.get("WHISPER_LANGUAGE") || "zh";
  if (!mlxBin) {
    console.log("- voice transcription disabled (MLX_WHISPER_BIN empty; npm run whisper:install)");
  } else if (existsSync(mlxBin)) {
    ok(`voice: MLX_WHISPER_BIN points to an existing binary (language ${langPref})`);
  } else {
    bad("voice: MLX_WHISPER_BIN set but binary is missing", "run: npm run whisper:install");
  }

  console.log(
    failures === 0
      ? "\n\x1b[1;32mAll checks passed.\x1b[0m"
      : `\n\x1b[1;31m${failures} check(s) failed.\x1b[0m`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
