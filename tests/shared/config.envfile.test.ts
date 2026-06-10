import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../../src/shared/config.js";

// This test mutates process.env (dotenv loads into it), so it lives in its own
// file (vitest isolates files) and restores every key it touches.
const saved: Record<string, string | undefined> = {};
function snapshot(...keys: string[]): void {
  for (const k of keys) saved[k] = process.env[k];
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

it("loadConfig honors TCB_ENV_FILE so dev can borrow the deployed .env", () => {
  snapshot("TCB_ENV_FILE", "TELEGRAM_BOT_TOKEN");
  delete process.env.TELEGRAM_BOT_TOKEN;

  const dir = mkdtempSync(join(tmpdir(), "tcb-envfile-"));
  const file = join(dir, "prod.env");
  writeFileSync(file, "TELEGRAM_BOT_TOKEN=987654321:DEVBORROW\n");
  process.env.TCB_ENV_FILE = file;

  // No env arg -> loadConfig reads the file pointed at by TCB_ENV_FILE.
  const cfg = loadConfig();
  expect(cfg.telegramBotToken).toBe("987654321:DEVBORROW");
});

it("without TCB_ENV_FILE, an explicit env object is used as-is", () => {
  snapshot("TCB_ENV_FILE");
  delete process.env.TCB_ENV_FILE;
  const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "111:EXPLICIT" } as NodeJS.ProcessEnv);
  expect(cfg.telegramBotToken).toBe("111:EXPLICIT");
});
