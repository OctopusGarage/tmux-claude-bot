/**
 * Feishu/Lark onboarding wizard. Scan a QR code with the Feishu app to create a
 * PersonalAgent application; the resulting credentials are written into `.env`
 * (LARK_* keys) using the same atomic 0600 writer as `npm run setup`. The
 * scanning user is auto-added to the allowlist. Run via `npm run setup:lark`.
 */
import { existsSync, readFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runLarkOnboardingWizard } from "../adapters/lark/onboarding-wizard.js";
import { serializeEnv } from "../core/onboarding.js";

const ENV_PATH = join(process.cwd(), ".env");

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
  const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const tmp = `${ENV_PATH}.tmp`;
  await writeFile(tmp, serializeEnv(current, values), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, ENV_PATH);
}

async function main(): Promise<void> {
  C.info("飞书接入向导：用飞书 App 扫码创建应用，凭证将写入 .env\n");

  const values = await runLarkOnboardingWizard(C);
  await writeEnv(values);

  console.log("");
  C.ok("应用创建成功，凭证已写入 .env");
  C.info(`App ID: ${values.LARK_APP_ID}`);
  C.info(`Tenant: ${values.LARK_DOMAIN}`);
  if (values.LARK_ALLOWED_OPEN_IDS) {
    C.info(`已授权扫码用户：${values.LARK_ALLOWED_OPEN_IDS}`);
  } else {
    C.warn(
      "未拿到扫码用户的 open_id —— LARK_ALLOWED_OPEN_IDS 为空（会拒绝所有人）。请手动把你的 open_id 填入 .env。",
    );
  }
  console.log("");
  C.info(
    '重启 bot 生效：launchctl kickstart -k "gui/$(id -u)/com.octopusgarage.tmux-claude-bot"（开发态则重启 npm run dev）',
  );
}

main().catch((e) => {
  C.err(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
