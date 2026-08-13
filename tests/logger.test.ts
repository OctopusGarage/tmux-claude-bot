import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWarningCoalescer } from "../src/shared/utils/log-coalescer.js";
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

  it("redacts common authorization, query-secret, and URL-credential forms", () => {
    const out = redactSecrets(
      "Authorization: Bearer synthetic-access https://user:synthetic-pass@example.test/x?api_key=synthetic-key",
    );
    expect(out).not.toContain("synthetic-access");
    expect(out).not.toContain("synthetic-pass");
    expect(out).not.toContain("synthetic-key");
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

describe("createWarningCoalescer", () => {
  it("keeps the first and periodic warning while demoting identical repeats", () => {
    let now = 1_000;
    const sink = { warn: vi.fn(), debug: vi.fn() };
    const warn = createWarningCoalescer(sink, { intervalMs: 5_000, now: () => now });

    warn("project:failure", "system gate failed", { data: { projectId: "project" } });
    now += 1_000;
    warn("project:failure", "system gate failed", { data: { projectId: "project" } });
    now += 5_000;
    warn("project:failure", "system gate failed", { data: { projectId: "project" } });

    expect(sink.warn).toHaveBeenCalledTimes(2);
    expect(sink.warn).toHaveBeenLastCalledWith("system gate failed", {
      data: { projectId: "project", repeatedSinceLastWarning: 1 },
    });
    expect(sink.debug).toHaveBeenCalledWith("system gate failed", {
      data: { projectId: "project", coalesced: true, repeatedSinceLastWarning: 1 },
    });
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
      pid: process.pid,
    });
  });

  it("recursively redacts sensitive structured keys without hiding safe counters", async () => {
    const { logger: freshLogger } = await import("../src/shared/utils/logger.js");
    freshLogger.info("structured", {
      data: {
        apiKey: "synthetic-key",
        nested: {
          authorization: "Bearer synthetic-access",
          refresh_token: "synthetic-refresh",
          tokenCount: 42,
          endpoint: "https://user:synthetic-pass@example.test/path",
        },
      },
    });
    const data = readRecords()[0]?.data as Record<string, unknown>;
    expect(data.apiKey).toBe("<redacted>");
    expect(data.nested).toEqual({
      authorization: "<redacted>",
      refresh_token: "<redacted>",
      tokenCount: 42,
      endpoint: "https://user:<redacted>@example.test/path",
    });
  });

  it("bounds oversized structured payloads", async () => {
    const { logger: freshLogger } = await import("../src/shared/utils/logger.js");
    freshLogger.info("oversized", { data: { output: "x".repeat(100_000) } });
    const record = readRecords()[0];
    if (record === undefined) throw new Error("expected one log record");
    expect(JSON.stringify(record.data).length).toBeLessThan(40_000);
    expect((record.data as { output: string }).output).toContain("[truncated");
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

  it("caps archived log bytes while preserving today's active file", async () => {
    const originalLogDir = process.env.TCB_LOG_DIR;
    const dir = fs.mkdtempSync(join(os.tmpdir(), "tcb-logger-retention-"));
    const stamp = (daysAgo: number): string => {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
      ].join("");
    };
    const oldest = join(dir, `tcb-${stamp(2)}.jsonl`);
    const newer = join(dir, `tcb-${stamp(1)}.jsonl`);
    try {
      fs.writeFileSync(oldest, "");
      fs.truncateSync(oldest, 140 * 1024 * 1024);
      fs.writeFileSync(newer, "");
      fs.truncateSync(newer, 140 * 1024 * 1024);
      process.env.TCB_LOG_DIR = dir;
      vi.resetModules();
      const { logger: retentionLogger } = await import("../src/shared/utils/logger.js");

      retentionLogger.info("trigger retention");

      expect(fs.existsSync(oldest)).toBe(false);
      expect(fs.existsSync(newer)).toBe(true);
      expect(fs.readdirSync(dir)).toContain(`tcb-${stamp(0)}.jsonl`);
    } finally {
      if (originalLogDir === undefined) delete process.env.TCB_LOG_DIR;
      else process.env.TCB_LOG_DIR = originalLogDir;
      fs.rmSync(dir, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});
