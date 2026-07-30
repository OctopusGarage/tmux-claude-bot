/**
 * Guided setup wizard: prompts for the values that have no sane default,
 * validates the bot token live, auto-captures the operator's Telegram id,
 * and writes a 0600 `.env`. Run via `npm run setup` (add `--reconfigure`
 * to edit an existing config, `--yes` for non-interactive).
 */
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Bot } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { runLarkOnboardingWizard } from "../adapters/lark/onboarding-wizard.js";
import { isUiLang, type Lang } from "../core/i18n/index.js";
import {
  parseSetupLang,
  SETUP_LANG_PROMPT,
  type SetupMessages,
  setupMessages,
} from "../core/i18n/setup.js";
import {
  maskToken,
  parseEnv,
  pollForCaptureIds,
  serializeEnv,
  validateTokenShape,
} from "../core/infra/onboarding.js";
import { appStateFile } from "../shared/state-dir.js";

/** Language for the pre-prompt guards + non-interactive run: UI_LANG env, else English. */
function envLang(): Lang {
  const v = process.env.UI_LANG;
  return v && isUiLang(v) ? v : "en";
}

const ROOT = process.cwd();
// `.env` lives in the state dir (alongside the other state files), NOT the code
// install dir — so the deploy's `rsync --delete` never touches it. The template
// (.env.example) is a shipped code file, read from the install dir.
const ENV_PATH = appStateFile(".env");
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
    return me.username;
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
async function captureIds(token: string, M: SetupMessages, proxy?: string): Promise<string[]> {
  const bot = botFor(token, proxy);
  return pollForCaptureIds(
    {
      getUpdates: (offset) =>
        bot.api.getUpdates({ offset, timeout: 0, allowed_updates: ["message"] }),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      onCapture: (id, username) => C.ok(M.captured(username ? `@${username} ` : "", id)),
    },
    CAPTURE_TIMEOUT_MS,
  );
}

async function main(): Promise<void> {
  // Guards + non-interactive run can't prompt, so they fall back to UI_LANG/English.
  const M0 = setupMessages(envLang());

  if (!existsSync(EXAMPLE_PATH)) {
    C.err(M0.envExampleNotFound(EXAMPLE_PATH));
    process.exit(1);
  }
  const template = readFileSync(EXAMPLE_PATH, "utf8");
  const existing = existsSync(ENV_PATH)
    ? parseEnv(readFileSync(ENV_PATH, "utf8"))
    : new Map<string, string>();

  if (existsSync(ENV_PATH) && !args.has("--reconfigure") && !NON_INTERACTIVE && !DRY_RUN) {
    C.warn(M0.envExists(ENV_PATH));
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
      C.info(M0.noTelegramTokenKeepLark);
    } else {
      C.err(M0.yesNeedsToken);
      process.exit(1);
    }
    await writeEnv(template, { ...Object.fromEntries(existing), ...values });
    C.ok(M0.wroteEnvNonInteractive);
    if (
      values.TELEGRAM_BOT_TOKEN &&
      !(
        values.TELEGRAM_ALLOWED_USER_IDS ||
        existing.get("TELEGRAM_ALLOWED_USER_IDS") ||
        existing.get("ALLOWED_USER_IDS")
      )
    ) {
      C.warn(M0.allowedIdsEmpty);
    }
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def = ""): Promise<string> => {
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def;
  };

  try {
    // Pick the wizard language first, then run all guidance in it.
    const langChoice = await ask(SETUP_LANG_PROMPT, "1");
    const lang = parseSetupLang(langChoice) ?? "en";
    const M = setupMessages(lang);
    values.UI_LANG = lang;

    C.info(M.configuring);

    // 0. Which chat app(s) to connect?
    const choice = await ask(M.whichChatApp, "1");
    const wantTelegram = choice === "1" || choice === "3";
    const wantLark = choice === "2" || choice === "3";
    if (!wantTelegram && !wantLark) {
      C.err(M.invalidChatChoice);
      process.exit(1);
    }

    // 1. Telegram (token + authorized ids), only if chosen.
    if (wantTelegram) {
      const proxyPre =
        (await ask(
          M.proxyPrompt,
          existing.get("TELEGRAM_HTTP_PROXY") ?? existing.get("HTTP_PROXY") ?? "",
        )) || undefined;
      values.TELEGRAM_HTTP_PROXY = proxyPre ?? "";

      let token = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        token = await ask(
          M.tokenPrompt,
          DRY_RUN
            ? "123456789:DRYRUN0000000000000000000000000000000"
            : (existing.get("TELEGRAM_BOT_TOKEN") ?? existing.get("BOT_TOKEN") ?? ""),
        );
        if (!validateTokenShape(token)) {
          C.warn(M.tokenBadShape);
          continue;
        }
        const username = DRY_RUN ? "dryrun_bot" : await validateToken(token, proxyPre);
        if (username) {
          C.ok(M.botOk(username, maskToken(token)));
          break;
        }
        C.warn(M.tokenRejected);
        token = "";
      }
      if (!validateTokenShape(token)) {
        C.err(M.noTokenAfter3);
        process.exit(1);
      }
      values.TELEGRAM_BOT_TOKEN = token;

      let ids: string[] = [];
      if (DRY_RUN) {
        C.info(M.dryRunSkipCapture);
        ids = ["123456789"];
      } else {
        C.info(M.authorizeNow);
        C.info(M.waitingUpTo(CAPTURE_TIMEOUT_MS / 1000));
        try {
          ids = await captureIds(token, M, values.TELEGRAM_HTTP_PROXY || undefined);
        } catch (e) {
          C.warn(M.captureListenerFailed(e instanceof Error ? e.message : String(e)));
          C.warn(M.botAlreadyRunningHint);
        }
      }
      if (ids.length === 0) {
        C.warn(M.noMessageReceived);
        const manual = await ask(
          M.enterIdsManually,
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
        C.info(M.dryRunSkipLark);
        larkValues = {
          LARK_ENABLED: "true",
          LARK_APP_ID: "cli_dryrun",
          LARK_APP_SECRET: "dryrun_secret",
          LARK_DOMAIN: "feishu",
          LARK_ALLOWED_OPEN_IDS: "ou_dryrun",
        };
      } else {
        C.info(M.larkIntro);
        larkValues = await runLarkOnboardingWizard(C, M);
      }
      Object.assign(values, larkValues);
      C.ok(M.larkConnected(larkValues.LARK_APP_ID ?? "", larkValues.LARK_DOMAIN ?? ""));
      if (larkValues.LARK_ALLOWED_OPEN_IDS) {
        C.info(M.larkAuthorizedUser(larkValues.LARK_ALLOWED_OPEN_IDS));
      } else {
        C.warn(M.larkNoOpenId);
      }
    }

    // 3. CD_ALLOWED_DIRS
    values.CD_ALLOWED_DIRS = await ask(
      M.allowedDirsPrompt,
      existing.get("CD_ALLOWED_DIRS") ?? homedir(),
    );

    // 4. Optional vars
    values.CLAUDE_START_COMMAND = await ask(
      M.claudeStartPrompt,
      existing.get("CLAUDE_START_COMMAND") ?? "claude-yolo",
    );
    const venvWhisper = join(ROOT, ".venv", "bin", "mlx_whisper");
    const mlxDefault =
      existing.get("MLX_WHISPER_BIN") || (existsSync(venvWhisper) ? venvWhisper : "");
    C.info(M.voiceIntro);
    C.info(mlxDefault ? M.voiceFoundBinary : M.voiceSkipHint);
    values.MLX_WHISPER_BIN = await ask(M.mlxPathPrompt, mlxDefault);
    values.WHISPER_LANGUAGE = await ask(
      M.voiceLangPrompt,
      existing.get("WHISPER_LANGUAGE") ?? "zh",
    );

    // 5. Keep-awake (macOS only — a sleeping laptop is what drops the bot from
    // your phone). Opt-in: default No, since it changes power behaviour.
    if (process.platform === "darwin") {
      C.info(M.keepAwakeIntro);
      const def = existing.get("TCB_KEEP_AWAKE") === "1" ? "y" : "n";
      const on = /^y/i.test(await ask(M.keepAwakePrompt, def));
      values.TCB_KEEP_AWAKE = on ? "1" : "0";
      if (on) C.info(M.keepAwakeClamshellHint);
    }

    // 6. Home operator session (opt-in, default No).
    C.info(M.homeOperatorIntro);
    const defOperator = existing.get("HOME_OPERATOR_ENABLED") === "true" ? "y" : "n";
    const wantOperator = /^y/i.test(await ask(M.homeOperatorPrompt, defOperator));
    if (wantOperator) {
      values.HOME_OPERATOR_ENABLED = "true";
      values.HOME_OPERATOR_AGENT = await ask(
        M.homeOperatorAgentPrompt,
        existing.get("HOME_OPERATOR_AGENT") ?? "claude",
      );
    } else {
      values.HOME_OPERATOR_ENABLED = "false";
    }

    if (DRY_RUN) {
      C.ok(M.dryRunComplete);
      for (const [k, v] of Object.entries(values)) {
        console.log(`  ${k}=${/TOKEN|SECRET/.test(k) ? "***" : v}`);
      }
      return;
    }

    await writeEnv(template, { ...Object.fromEntries(existing), ...values });
    C.ok(M.wroteEnv(ENV_PATH));
    if (values.TELEGRAM_BOT_TOKEN) {
      C.info(M.telegramIds(values.TELEGRAM_ALLOWED_USER_IDS || M.telegramIdsNone));
    }
    if (values.LARK_ENABLED === "true") {
      C.info(M.larkConfiguredRestart);
    }
  } finally {
    rl.close();
  }
}

async function writeEnv(template: string, values: Record<string, string>): Promise<void> {
  await mkdir(dirname(ENV_PATH), { recursive: true }); // state dir may not exist yet
  const tmp = `${ENV_PATH}.tmp`;
  await writeFile(tmp, serializeEnv(template, values), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, ENV_PATH);
}

main().catch((e) => {
  C.err(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
