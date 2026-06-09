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
import {
  maskToken,
  parseCaptureUpdate,
  parseEnv,
  serializeEnv,
  validateTokenShape,
} from "../core/onboarding.js";

const ROOT = process.cwd();
const ENV_PATH = join(ROOT, ".env");
const EXAMPLE_PATH = join(ROOT, ".env.example");
const CAPTURE_TIMEOUT_MS = 60_000;

const args = new Set(process.argv.slice(2));
const NON_INTERACTIVE = args.has("--yes");

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

/** Briefly long-poll until the operator messages the bot, returning captured ids. */
async function captureIds(token: string, proxy?: string): Promise<string[]> {
  const bot = botFor(token, proxy);
  const ids: string[] = [];
  return new Promise<string[]>((resolve, reject) => {
    const done = (result: string[]) => {
      clearTimeout(timer);
      void bot.stop().then(() => resolve(result));
    };
    const timer = setTimeout(() => done(ids), CAPTURE_TIMEOUT_MS);
    bot.on("message", (ctx) => {
      const hit = parseCaptureUpdate(ctx.update);
      if (hit && !ids.includes(hit.id)) {
        ids.push(hit.id);
        C.ok(`Captured ${hit.username ? `@${hit.username} ` : ""}(${hit.id})`);
        done(ids);
      }
    });
    bot.start({ drop_pending_updates: true }).catch((err) => {
      clearTimeout(timer);
      void bot.stop().catch(() => undefined);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
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

  if (existsSync(ENV_PATH) && !args.has("--reconfigure") && !NON_INTERACTIVE) {
    C.warn(
      `${ENV_PATH} already exists. Re-run with --reconfigure (npm run setup:reconfigure) to edit it.`,
    );
    process.exit(0);
  }

  const values: Record<string, string> = {};

  // Non-interactive: take BOT_TOKEN from env, keep existing/default everything else.
  if (NON_INTERACTIVE) {
    const token = process.env.BOT_TOKEN ?? existing.get("BOT_TOKEN") ?? "";
    if (!validateTokenShape(token)) {
      C.err("--yes requires a valid BOT_TOKEN in the environment.");
      process.exit(1);
    }
    values.BOT_TOKEN = token;
    await writeEnv(template, { ...Object.fromEntries(existing), ...values });
    C.ok("Wrote .env (non-interactive).");
    if (!(values.ALLOWED_USER_IDS || existing.get("ALLOWED_USER_IDS"))) {
      C.warn(
        "ALLOWED_USER_IDS is empty — the bot will reject ALL messages until you set it (npm run setup:reconfigure).",
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

    // 1. BOT_TOKEN (required, validated live). Ask proxy once, up front.
    const proxyPre =
      (await ask("HTTP proxy for Telegram (optional)", existing.get("HTTP_PROXY") ?? "")) ||
      undefined;
    values.HTTP_PROXY = proxyPre ?? "";

    let token = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      token = await ask("Telegram bot token (from @BotFather)", existing.get("BOT_TOKEN") ?? "");
      if (!validateTokenShape(token)) {
        C.warn("That doesn't look like a token (digits:letters). Try again.");
        continue;
      }
      const username = await validateToken(token, proxyPre);
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
    values.BOT_TOKEN = token;

    // 2. ALLOWED_USER_IDS via auto-capture
    C.info("Now authorize yourself: open Telegram and send your bot ANY message.");
    C.info(`Waiting up to ${CAPTURE_TIMEOUT_MS / 1000}s…`);
    let ids: string[] = [];
    try {
      ids = await captureIds(token, values.HTTP_PROXY || undefined);
    } catch (e) {
      C.warn(`Could not start capture listener (${e instanceof Error ? e.message : String(e)}).`);
      C.warn(
        "If the bot is already running, stop it first (npm run service:uninstall) or enter your id manually.",
      );
    }
    if (ids.length === 0) {
      C.warn("No message received.");
      const manual = await ask(
        "Enter your numeric Telegram id(s), comma-separated",
        existing.get("ALLOWED_USER_IDS") ?? "",
      );
      ids = manual
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    values.ALLOWED_USER_IDS = ids.join(",");

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
    C.info(
      "Voice transcription is optional. To install it project-managed: npm run whisper:install",
    );
    values.MLX_WHISPER_BIN = await ask(
      "mlx_whisper binary for voice (optional; blank to disable)",
      mlxDefault,
    );

    await writeEnv(template, { ...Object.fromEntries(existing), ...values });
    C.ok(`Wrote ${ENV_PATH}`);
    C.info(`Authorized ids: ${values.ALLOWED_USER_IDS || "(none — bot will reject everyone!)"}`);
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
