/**
 * Guided setup wizard: prompts for the values that have no sane default,
 * validates the bot token live, auto-captures the operator's Telegram id,
 * and writes a 0600 `.env`. Run via `npm run setup` (add `--reconfigure`
 * to edit an existing config, `--yes` for non-interactive).
 */
import { existsSync, readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Bot } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { runLarkOnboardingWizard } from "../adapters/lark/onboarding-wizard.js";
import {
  maskToken,
  parseEnv,
  pollForCaptureIds,
  serializeEnv,
  validateTokenShape,
} from "../core/onboarding.js";

const ROOT = process.cwd();
const ENV_PATH = join(ROOT, ".env");
const EXAMPLE_PATH = join(ROOT, ".env.example");
const CAPTURE_TIMEOUT_MS = 60_000;

const args = new Set(process.argv.slice(2));
const NON_INTERACTIVE = args.has("--yes");
// Walk the full wizard locally without touching Telegram / Feishu / the real .env:
// stubs the live token check, id capture and QR scan, and prints (not writes) the
// resolved config. For verifying the flow + prompts during development.
const DRY_RUN = args.has("--dry-run");

const C = {
  info: (s: string) => console.log(`\x1b[1;34m=>\x1b[0m ${s}`),
  ok: (s: string) => console.log(`\x1b[1;32m✓\x1b[0m ${s}`),
  warn: (s: string) => console.log(`\x1b[1;33m!\x1b[0m ${s}`),
  err: (s: string) => console.error(`\x1b[1;31mxx\x1b[0m ${s}`),
};

function botFor(token: string, proxy?: string): Bot {
  const options = proxy
    ? {
        client: {
          baseFetchConfig: { agent: new HttpsProxyAgent(proxy) } as Record<string, unknown>,
        },
      }
    : undefined;
  return new Bot(token, options);
}

async function validateToken(token: string, proxy?: string): Promise<string | null> {
  try {
    const me = await botFor(token, proxy).api.getMe();
    return me.username ?? null;
  } catch {
    return null;
  }
}

/**
 * Wait until the operator messages the bot, returning the captured id(s). The
 * short-poll loop lives in core/onboarding (`pollForCaptureIds`, unit-tested); we
 * just wire the real bot.api.getUpdates and the clock. Short polls (timeout=0)
 * survive a CN proxy that drops long-held connections; crash-proof, falling back
 * to manual entry on timeout.
 */
async function captureIds(token: string, proxy?: string): Promise<string[]> {
  const bot = botFor(token, proxy);
  return pollForCaptureIds(
    {
      getUpdates: (offset) =>
        bot.api.getUpdates({ offset, timeout: 0, allowed_updates: ["message"] }),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      onCapture: (id, username) => C.ok(`Captured ${username ? `@${username} ` : ""}(${id})`),
    },
    CAPTURE_TIMEOUT_MS,
  );
}

async function main(): Promise<void> {
  if (!existsSync(EXAMPLE_PATH)) {
    C.err(`.env.example not found at ${EXAMPLE_PATH}`);
    process.exit(1);
  }
  const template = readFileSync(EXAMPLE_PATH, "utf8");
  const existing = existsSync(ENV_PATH)
    ? parseEnv(readFileSync(ENV_PATH, "utf8"))
    : new Map<string, string>();

  if (existsSync(ENV_PATH) && !args.has("--reconfigure") && !NON_INTERACTIVE && !DRY_RUN) {
    C.warn(
      `${ENV_PATH} already exists. Re-run with --reconfigure (npm run setup:reconfigure) to edit it.`,
    );
    process.exit(0);
  }

  const values: Record<string, string> = {};

  // Non-interactive (CI / re-install): take TELEGRAM_BOT_TOKEN from env, keep
  // everything else. Can't do the Feishu QR scan headlessly, so it's
  // Telegram-oriented — but it no longer hard-fails when there's no token (a
  // Feishu-only install whose LARK_* config is already in .env is preserved).
  if (NON_INTERACTIVE) {
    const token =
      process.env.TELEGRAM_BOT_TOKEN ??
      process.env.BOT_TOKEN ??
      existing.get("TELEGRAM_BOT_TOKEN") ??
      existing.get("BOT_TOKEN") ??
      "";
    if (validateTokenShape(token)) {
      values.TELEGRAM_BOT_TOKEN = token;
    } else if (existing.get("LARK_ENABLED") === "true") {
      C.info("No TELEGRAM_BOT_TOKEN — keeping existing Feishu/Lark-only config.");
    } else {
      C.err("--yes needs either a valid TELEGRAM_BOT_TOKEN or an existing LARK_* (Feishu) config.");
      process.exit(1);
    }
    await writeEnv(template, { ...Object.fromEntries(existing), ...values });
    C.ok("Wrote .env (non-interactive).");
    if (
      values.TELEGRAM_BOT_TOKEN &&
      !(
        values.TELEGRAM_ALLOWED_USER_IDS ||
        existing.get("TELEGRAM_ALLOWED_USER_IDS") ||
        existing.get("ALLOWED_USER_IDS")
      )
    ) {
      C.warn(
        "TELEGRAM_ALLOWED_USER_IDS is empty — the bot will reject ALL messages until you set it (npm run setup:reconfigure).",
      );
    }
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def = ""): Promise<string> => {
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def;
  };

  try {
    C.info("Configuring tmux-claude-bot. Press Enter to accept the [default].");

    // 0. Which chat app(s) to connect?
    const choice = await ask("Which chat app? 1) Telegram  2) Feishu/Lark  3) Both", "1");
    const wantTelegram = choice === "1" || choice === "3";
    const wantLark = choice === "2" || choice === "3";
    if (!wantTelegram && !wantLark) {
      C.err("Invalid choice — pick 1, 2, or 3.");
      process.exit(1);
    }

    // 1. Telegram (token + authorized ids), only if chosen.
    if (wantTelegram) {
      const proxyPre =
        (await ask(
          "HTTP proxy for Telegram (optional)",
          existing.get("TELEGRAM_HTTP_PROXY") ?? existing.get("HTTP_PROXY") ?? "",
        )) || undefined;
      values.TELEGRAM_HTTP_PROXY = proxyPre ?? "";

      let token = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        token = await ask(
          "Telegram bot token (from @BotFather)",
          DRY_RUN
            ? "123456789:DRYRUN0000000000000000000000000000000"
            : (existing.get("TELEGRAM_BOT_TOKEN") ?? existing.get("BOT_TOKEN") ?? ""),
        );
        if (!validateTokenShape(token)) {
          C.warn("That doesn't look like a token (digits:letters). Try again.");
          continue;
        }
        const username = DRY_RUN ? "dryrun_bot" : await validateToken(token, proxyPre);
        if (username) {
          C.ok(`Bot: @${username}  (token ${maskToken(token)})`);
          break;
        }
        C.warn("Telegram rejected that token. Check it and try again.");
        token = "";
      }
      if (!validateTokenShape(token)) {
        C.err("No valid token after 3 attempts. Aborting.");
        process.exit(1);
      }
      values.TELEGRAM_BOT_TOKEN = token;

      let ids: string[] = [];
      if (DRY_RUN) {
        C.info("[dry-run] skipping live id capture; using 123456789.");
        ids = ["123456789"];
      } else {
        C.info("Now authorize yourself: open Telegram and send your bot ANY message.");
        C.info(`Waiting up to ${CAPTURE_TIMEOUT_MS / 1000}s…`);
        try {
          ids = await captureIds(token, values.TELEGRAM_HTTP_PROXY || undefined);
        } catch (e) {
          C.warn(
            `Could not start capture listener (${e instanceof Error ? e.message : String(e)}).`,
          );
          C.warn(
            "If the bot is already running, stop it first (npm run service:uninstall) or enter your id manually.",
          );
        }
      }
      if (ids.length === 0) {
        C.warn("No message received.");
        const manual = await ask(
          "Enter your numeric Telegram id(s), comma-separated",
          existing.get("TELEGRAM_ALLOWED_USER_IDS") ?? existing.get("ALLOWED_USER_IDS") ?? "",
        );
        ids = manual
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      values.TELEGRAM_ALLOWED_USER_IDS = ids.join(",");
    }

    // 2. Feishu/Lark — scan a QR to create the app (inline QR wizard).
    if (wantLark) {
      let larkValues: Record<string, string>;
      if (DRY_RUN) {
        C.info("[dry-run] skipping Feishu QR; using placeholder LARK_* values.");
        larkValues = {
          LARK_ENABLED: "true",
          LARK_APP_ID: "cli_dryrun",
          LARK_APP_SECRET: "dryrun_secret",
          LARK_DOMAIN: "feishu",
          LARK_ALLOWED_OPEN_IDS: "ou_dryrun",
        };
      } else {
        C.info("飞书接入：用飞书 App 扫码创建应用。");
        larkValues = await runLarkOnboardingWizard(C);
      }
      Object.assign(values, larkValues);
      C.ok(`飞书已接入 · App ID: ${larkValues.LARK_APP_ID} · Tenant: ${larkValues.LARK_DOMAIN}`);
      if (larkValues.LARK_ALLOWED_OPEN_IDS) {
        C.info(`已授权扫码用户：${larkValues.LARK_ALLOWED_OPEN_IDS}`);
      } else {
        C.warn("未拿到扫码用户 open_id —— LARK_ALLOWED_OPEN_IDS 为空，请稍后手动填入 .env。");
      }
    }

    // 3. CD_ALLOWED_DIRS
    values.CD_ALLOWED_DIRS = await ask(
      "Allowed project directories (comma-separated)",
      existing.get("CD_ALLOWED_DIRS") ?? homedir(),
    );

    // 4. Optional vars
    values.CLAUDE_START_COMMAND = await ask(
      "Claude start command",
      existing.get("CLAUDE_START_COMMAND") ?? "claude-yolo",
    );
    const venvWhisper = join(ROOT, ".venv", "bin", "mlx_whisper");
    const mlxDefault =
      existing.get("MLX_WHISPER_BIN") || (existsSync(venvWhisper) ? venvWhisper : "");
    C.info("Voice transcription (optional): turn voice messages into text. Apple Silicon only.");
    C.info(
      mlxDefault
        ? "Found an mlx_whisper binary — press Enter to use it, or blank it out to disable voice."
        : "Press ENTER to skip for now. To enable later: `npm run whisper:install` auto-fills this. (No need to type a path by hand.)",
    );
    values.MLX_WHISPER_BIN = await ask("mlx_whisper binary path (Enter to skip)", mlxDefault);
    values.WHISPER_LANGUAGE = await ask(
      "Voice recognition language (zh/en/auto)",
      existing.get("WHISPER_LANGUAGE") ?? "zh",
    );

    if (DRY_RUN) {
      C.ok("[dry-run] flow complete. Resolved config (NOT written, secrets masked):");
      for (const [k, v] of Object.entries(values)) {
        console.log(`  ${k}=${/TOKEN|SECRET/.test(k) ? "***" : v}`);
      }
      return;
    }

    await writeEnv(template, { ...Object.fromEntries(existing), ...values });
    C.ok(`Wrote ${ENV_PATH}`);
    if (values.TELEGRAM_BOT_TOKEN) {
      C.info(
        `Telegram ids: ${values.TELEGRAM_ALLOWED_USER_IDS || "(none — Telegram will reject everyone!)"}`,
      );
    }
    if (values.LARK_ENABLED === "true") {
      C.info("Feishu/Lark configured. Restart the bot to connect.");
    }
  } finally {
    rl.close();
  }
}

async function writeEnv(template: string, values: Record<string, string>): Promise<void> {
  const tmp = `${ENV_PATH}.tmp`;
  await writeFile(tmp, serializeEnv(template, values), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, ENV_PATH);
}

main().catch((e) => {
  C.err(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
