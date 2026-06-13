import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/shared/config.js";

/**
 * Startup smoke test. Unit config tests construct `loadConfig({ ... })` from an
 * explicit object, which bypasses dotenv — so they never see the value class
 * that actually bit us in production: a `KEY=` line, which dotenv injects as the
 * empty string "". This test goes through the *real* dotenv path (a temp .env +
 * TCB_ENV_FILE) so an env file that crashes startup fails here instead.
 */
const KEYS = [
  "TCB_ENV_FILE",
  "TELEGRAM_BOT_TOKEN",
  "POLL_INTERVAL_MS",
  "IDLE_POLL_TICKS",
  "MAX_WAIT_DONE_TOTAL_MS",
  "RATE_LIMIT_MS",
  "MAX_CONCURRENT_SESSIONS",
  "SESSION_WARMUP_MS",
  "LARK_ENABLED",
  "LARK_DOMAIN",
  "CLAUDE_START_COMMAND",
];

describe("startup smoke: loadConfig over the real dotenv path", () => {
  let saved: Record<string, string | undefined>;
  let dir: string;

  beforeEach(() => {
    // dotenv does NOT override already-set vars, so clear the keys first and
    // restore them after — otherwise the .env under test wouldn't take effect.
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-env-"));
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const withEnvFile = (body: string): void => {
    const f = nodePath.join(dir, ".env");
    fs.writeFileSync(f, body);
    process.env.TCB_ENV_FILE = f;
  };

  it("a .env full of blank values boots on defaults (the prod crash class)", () => {
    withEnvFile(
      [
        "TELEGRAM_BOT_TOKEN=t",
        "POLL_INTERVAL_MS=",
        "IDLE_POLL_TICKS=",
        "MAX_WAIT_DONE_TOTAL_MS=",
        "RATE_LIMIT_MS=",
        "MAX_CONCURRENT_SESSIONS=",
        "SESSION_WARMUP_MS=",
        "LARK_DOMAIN=",
      ].join("\n"),
    );
    const cfg = loadConfig();
    expect(cfg.pollIntervalMs).toBe(1000);
    expect(cfg.idlePollTicks).toBe(5);
    expect(cfg.maxWaitDoneTotalMs).toBe(3600000);
    expect(cfg.maxConcurrentSessions).toBe(5);
  });

  it("a stray/garbage LARK_DOMAIN line doesn't take down a telegram-only install", () => {
    withEnvFile("TELEGRAM_BOT_TOKEN=t\nLARK_DOMAIN=garbage\n");
    expect(() => loadConfig()).not.toThrow();
  });

  it("a genuinely invalid numeric (non-empty) still fails loudly at startup", () => {
    withEnvFile("TELEGRAM_BOT_TOKEN=t\nPOLL_INTERVAL_MS=abc\n");
    expect(() => loadConfig()).toThrow();
  });

  it("a minimal valid .env loads with the expected token", () => {
    withEnvFile("TELEGRAM_BOT_TOKEN=real-token\n");
    expect(loadConfig().telegramBotToken).toBe("real-token");
  });
});
