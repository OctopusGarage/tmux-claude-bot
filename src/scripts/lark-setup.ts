/**
 * Feishu/Lark onboarding wizard. Scan a QR code with the Feishu app to create a
 * PersonalAgent application; the resulting credentials are written into `.env`
 * (LARK_* keys) using the same atomic 0600 writer as `npm run setup`. The
 * scanning user is auto-added to the allowlist. Run via `npm run setup:lark`.
 */
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { runLarkOnboardingWizard } from "../adapters/lark/onboarding-wizard.js";
import type { Lang } from "../core/i18n/index.js";
import { parseSetupLang, SETUP_LANG_PROMPT, setupMessages } from "../core/i18n/setup.js";
import { serializeEnv } from "../core/infra/onboarding.js";
import { managedRestartCommand } from "../core/platform/service-hints.js";
import { appStateFile } from "../shared/state-dir.js";

// `.env` lives in the state dir (not cwd) — kept out of the deploy's rsync --delete.
const ENV_PATH = appStateFile(".env");
const RESTART_CMD = managedRestartCommand();

const C = {
  info: (s: string) => console.log(`\x1b[1;34m=>\x1b[0m ${s}`),
  ok: (s: string) => console.log(`\x1b[1;32m✓\x1b[0m ${s}`),
  warn: (s: string) => console.log(`\x1b[1;33m!\x1b[0m ${s}`),
  err: (s: string) => console.error(`\x1b[1;31mxx\x1b[0m ${s}`),
};

/**
 * Upsert the LARK_* values into the existing `.env`, preserving every other
 * line and comment. serializeEnv treats the current file as the template, so it
 * replaces existing LARK_* lines and appends any that are missing.
 */
async function writeEnv(values: Record<string, string>): Promise<void> {
  await mkdir(dirname(ENV_PATH), { recursive: true }); // state dir may not exist yet
  const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const tmp = `${ENV_PATH}.tmp`;
  await writeFile(tmp, serializeEnv(current, values), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, ENV_PATH);
}

async function askLang(): Promise<Lang> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${SETUP_LANG_PROMPT} [1]: `)).trim();
    return parseSetupLang(answer || "1") ?? "en";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const lang = await askLang();
  const M = setupMessages(lang);

  C.info(`${M.larkWizardIntro}\n`);

  const values = await runLarkOnboardingWizard(C, M);
  values.UI_LANG = lang;
  await writeEnv(values);

  console.log("");
  C.ok(M.larkAppCreated);
  C.info(`App ID: ${values.LARK_APP_ID}`);
  C.info(`Tenant: ${values.LARK_DOMAIN}`);
  if (values.LARK_ALLOWED_OPEN_IDS) {
    C.info(M.larkAuthorizedUser(values.LARK_ALLOWED_OPEN_IDS));
  } else {
    C.warn(M.larkNoOpenId);
  }
  console.log("");
  C.info(M.larkRestartHint(RESTART_CMD));
}

main().catch((e) => {
  C.err(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
