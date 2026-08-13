import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger, redactSecrets } from "../src/shared/utils/logger.js";

describe("redactSecrets", () => {
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.BOT_TOKEN;
  });

  // Synthetic, non-functional fixture: token-shaped enough for the redaction
  // regex (botID:secret) but deliberately not a real Telegram token pattern
  // (secret part is not the 35-char shape secret scanners match on).
  const FAKE_TOKEN = "123456789:THIS_IS_A_FAKE_TEST_TOKEN_NOT_REAL";

  it("redacts a Bot API token embedded in a fetch error URL", () => {
    const msg = `request to https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates failed`;
    const out = redactSecrets(msg);
    expect(out).not.toContain("THIS_IS_A_FAKE_TEST_TOKEN_NOT_REAL");
    expect(out).toContain("bot<redacted-token>");
  });

  it("redacts the exact configured token wherever it appears", () => {
    process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
    const out = redactSecrets(`token leaked: ${FAKE_TOKEN} end`);
    expect(out).toBe("token leaked: <redacted-token> end");
  });

  it("leaves token-free messages untouched", () => {
    const msg = "[smart-fetch] recovered via direct after preferred route failed";
    expect(redactSecrets(msg)).toBe(msg);
  });
});

describe("logger write", () => {
  it("writes info without throwing", () => {
    expect(() => logger.info("test message")).not.toThrow();
  });

  it("writes with context fields without throwing", () => {
    expect(() =>
      logger.info("ctx test", { session: "s1", chatId: "c1", channel: "lark" }),
    ).not.toThrow();
  });

  it("writes warn without throwing", () => {
    expect(() => logger.warn("warn message")).not.toThrow();
  });

  it("calls debug without throwing", () => {
    expect(() => logger.debug("debug message")).not.toThrow();
  });
});

describe("redactSecrets (Lark app secret)", () => {
  it("redacts LARK_APP_SECRET wherever it appears", () => {
    const prev = process.env.LARK_APP_SECRET;
    process.env.LARK_APP_SECRET = "super-secret-feishu-value";
    try {
      const out = redactSecrets("lark error: appSecret=super-secret-feishu-value boom");
      expect(out).not.toContain("super-secret-feishu-value");
      expect(out).toContain("<redacted-token>");
    } finally {
      if (prev === undefined) delete process.env.LARK_APP_SECRET;
      else process.env.LARK_APP_SECRET = prev;
    }
  });
});

describe("logger (ambient context, component, err/data)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), "tcb-logger-"));
    process.env.TCB_LOG_DIR = dir;
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.TCB_LOG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function readRecords(): Array<Record<string, unknown>> {
    const file = fs.readdirSync(dir).find((f) => f.startsWith("tcb-") && f.endsWith(".jsonl"));
    if (!file) return [];
    return fs
      .readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it("attaches ambient context fields to a record", async () => {
    const { createLogger } = await import("../src/shared/utils/logger.js");
    const { runWithLogContext: run } = await import("../src/shared/utils/log-context.js");
    const log = createLogger("test.unit");
    run({ traceId: "t_z", session: "sess_a", chatId: "c1", channel: "lark" }, () => {
      log.info("hello", { data: { len: 3 } });
    });
    const recs = readRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      level: "INFO",
      component: "test.unit",
      msg: "hello",
      traceId: "t_z",
      session: "sess_a",
      chatId: "c1",
      channel: "lark",
      data: { len: 3 },
    });
  });

  it("works with no ambient context (fields omitted)", async () => {
    const { logger: freshLogger } = await import("../src/shared/utils/logger.js");
    freshLogger.info("bare");
    const rec = readRecords()[0];
    expect(rec).toMatchObject({ msg: "bare", level: "INFO" });
    expect(rec).not.toHaveProperty("traceId");
    expect(rec).not.toHaveProperty("session");
  });

  it("records an error with name/message/stack and redacts secrets in err", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot123:SECRETSECRETSECRETSECRET";
    const { logger: freshLogger } = await import("../src/shared/utils/logger.js");
    freshLogger.error("boom", { err: new Error("token bot123:SECRETSECRETSECRETSECRET leaked") });
    const rec = readRecords()[0];
    expect(rec).toBeDefined();
    if (rec === undefined) throw new Error("expected one log record");
    expect(rec.level).toBe("ERROR");
    expect((rec.err as { message: string }).message).not.toContain("SECRETSECRET");
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("never throws into the caller on a non-serializable data payload", async () => {
    const { logger: freshLogger } = await import("../src/shared/utils/logger.js");
    const circular: Record<string, unknown> = {};
    circular.self = circular; // JSON.stringify would throw
    expect(() => freshLogger.info("circular", { data: circular })).not.toThrow();
    const rec = readRecords()[0];
    expect(rec).toBeDefined();
    if (rec === undefined) throw new Error("expected one log record");
    expect(rec.msg).toBe("circular");
    expect((rec.data as { _serializeError?: string })._serializeError).toContain("circular");
  });
});

describe("logger state-directory isolation", () => {
  it("resolves the state log directory when each record is written", async () => {
    const originalStateDir = process.env.TCB_STATE_DIR;
    const originalLogDir = process.env.TCB_LOG_DIR;
    const firstStateDir = fs.mkdtempSync(join(os.tmpdir(), "tcb-logger-first-state-"));
    const secondStateDir = fs.mkdtempSync(join(os.tmpdir(), "tcb-logger-second-state-"));
    try {
      delete process.env.TCB_LOG_DIR;
      process.env.TCB_STATE_DIR = firstStateDir;
      vi.resetModules();
      const { logger: stateAwareLogger } = await import("../src/shared/utils/logger.js");

      process.env.TCB_STATE_DIR = secondStateDir;
      stateAwareLogger.info("after state-dir change");

      const secondLogDir = join(secondStateDir, "logs");
      expect(fs.readdirSync(secondLogDir)).toEqual([expect.stringMatching(/^tcb-\d{8}\.jsonl$/)]);
      expect(fs.existsSync(join(firstStateDir, "logs"))).toBe(false);
    } finally {
      if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = originalStateDir;
      if (originalLogDir === undefined) delete process.env.TCB_LOG_DIR;
      else process.env.TCB_LOG_DIR = originalLogDir;
      fs.rmSync(firstStateDir, { recursive: true, force: true });
      fs.rmSync(secondStateDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});
