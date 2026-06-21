import { afterEach, describe, expect, it } from "vitest";
import type { DoctorProbes } from "../src/core/infra/doctor.js";
import { renderDoctorReport, runDoctorChecks } from "../src/core/infra/doctor.js";

const VALID_TOKEN = `123456789:${"a".repeat(35)}`;

/** Probes describing a fully healthy install; override per test. */
function healthyProbes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    readEnv: () => new Map([["TELEGRAM_BOT_TOKEN", VALID_TOKEN]]),
    onPath: async () => true,
    serviceLoaded: async () => true,
    botProcessCount: async () => 1,
    caffeinateActive: async () => true,
    clamshellClosed: async () => false,
    sleepDisabled: async () => false,
    fileExists: () => true,
    ...over,
  };
}

describe("runDoctorChecks", () => {
  it("reports zero failures for a healthy install", async () => {
    const report = await runDoctorChecks(healthyProbes());
    expect(report.failures).toBe(0);
    expect(report.checks.some((c) => c.status === "bad")).toBe(false);
    expect(report.checks.some((c) => c.text.includes("Telegram configured"))).toBe(true);
    expect(report.checks.some((c) => c.text.includes("exactly one bot process"))).toBe(true);
  });

  it("fails with a setup hint when .env is missing", async () => {
    const report = await runDoctorChecks(healthyProbes({ readEnv: () => null }));
    const noEnv = report.checks.find((c) => c.text.includes("no .env"));
    expect(noEnv?.status).toBe("bad");
    expect(noEnv?.fix).toContain("npm run setup");
    expect(report.failures).toBeGreaterThan(0);
  });

  it("flags a malformed Telegram token", async () => {
    const report = await runDoctorChecks(
      healthyProbes({
        readEnv: () =>
          new Map([
            ["TELEGRAM_BOT_TOKEN", "not-a-token"],
            ["LARK_ENABLED", "true"],
            ["LARK_APP_ID", "cli_x"],
            ["LARK_APP_SECRET", "s"],
          ]),
      }),
    );
    expect(report.checks.some((c) => c.status === "bad" && c.text.includes("looks invalid"))).toBe(
      true,
    );
  });

  it("keeps the Lark app id out of the check text (sensitiveDetail only)", async () => {
    const report = await runDoctorChecks(
      healthyProbes({
        readEnv: () =>
          new Map([
            ["LARK_ENABLED", "true"],
            ["LARK_APP_ID", "cli_secret123"],
            ["LARK_APP_SECRET", "s"],
          ]),
      }),
    );
    const lark = report.checks.find((c) => c.text.includes("Feishu/Lark configured"));
    expect(lark?.status).toBe("ok");
    expect(lark?.text).not.toContain("cli_secret123");
    expect(lark?.sensitiveDetail).toContain("cli_secret123");
  });

  it("fails when no chat adapter is configured", async () => {
    const report = await runDoctorChecks(healthyProbes({ readEnv: () => new Map() }));
    expect(
      report.checks.some((c) => c.status === "bad" && c.text.includes("no chat adapter")),
    ).toBe(true);
  });

  it("fails when tmux is missing from PATH", async () => {
    const report = await runDoctorChecks(healthyProbes({ onPath: async (bin) => bin !== "tmux" }));
    const tmux = report.checks.find((c) => c.text.includes("tmux not found"));
    expect(tmux?.status).toBe("bad");
    // Platform-aware hint: "brew install tmux" (macOS) / "sudo apt install tmux …" (Linux).
    expect(tmux?.fix).toContain("install tmux");
  });

  it("fails when node is missing from PATH", async () => {
    const report = await runDoctorChecks(healthyProbes({ onPath: async (bin) => bin !== "node" }));
    const node = report.checks.find((c) => c.text.includes("node not found"));
    expect(node?.status).toBe("bad");
    expect(node?.fix).toContain("nvm");
  });

  it("fails when the service is not loaded", async () => {
    const report = await runDoctorChecks(healthyProbes({ serviceLoaded: async () => false }));
    expect(report.checks.some((c) => c.status === "bad" && c.text.includes("not loaded"))).toBe(
      true,
    );
  });

  it("flags zero and multiple bot processes (the 409 trap)", async () => {
    const none = await runDoctorChecks(healthyProbes({ botProcessCount: async () => 0 }));
    expect(none.checks.some((c) => c.status === "bad" && c.text.includes("no bot process"))).toBe(
      true,
    );

    const two = await runDoctorChecks(healthyProbes({ botProcessCount: async () => 2 }));
    expect(two.checks.some((c) => c.status === "bad" && c.text.includes("409"))).toBe(true);
  });

  it("treats unconfigured voice as info, set-but-missing binary as failure", async () => {
    const off = await runDoctorChecks(healthyProbes());
    expect(
      off.checks.some(
        (c) => c.status === "info" && c.text.includes("voice transcription disabled"),
      ),
    ).toBe(true);

    const missing = await runDoctorChecks(
      healthyProbes({
        readEnv: () =>
          new Map([
            ["TELEGRAM_BOT_TOKEN", VALID_TOKEN],
            ["MLX_WHISPER_BIN", "/opt/whisper/bin"],
          ]),
        fileExists: () => false,
      }),
    );
    expect(
      missing.checks.some((c) => c.status === "bad" && c.text.includes("binary is missing")),
    ).toBe(true);

    const present = await runDoctorChecks(
      healthyProbes({
        readEnv: () =>
          new Map([
            ["TELEGRAM_BOT_TOKEN", VALID_TOKEN],
            ["MLX_WHISPER_BIN", "/opt/whisper/bin"],
          ]),
      }),
    );
    expect(present.checks.some((c) => c.status === "ok" && c.text.includes("voice:"))).toBe(true);
  });
});

describe("renderDoctorReport", () => {
  it("renders a redacted plain-text report without sensitive details", async () => {
    const report = await runDoctorChecks(
      healthyProbes({
        readEnv: () =>
          new Map([
            ["LARK_ENABLED", "true"],
            ["LARK_APP_ID", "cli_secret123"],
            ["LARK_APP_SECRET", "s"],
          ]),
        serviceLoaded: async () => false,
      }),
    );
    const text = renderDoctorReport(report, { redacted: true });

    expect(text).toContain("✅");
    expect(text).toContain("❌");
    expect(text).toContain("fix: run: npm run service:install");
    expect(text).not.toContain("cli_secret123");
    // Chat output must carry no ANSI escapes.
    expect(text).not.toContain("\x1b[");
    expect(text).toContain("1 check(s) failed");
  });

  it("includes sensitive details when not redacted and reports success", async () => {
    const report = await runDoctorChecks(
      healthyProbes({
        readEnv: () =>
          new Map([
            ["LARK_ENABLED", "true"],
            ["LARK_APP_ID", "cli_secret123"],
            ["LARK_APP_SECRET", "s"],
          ]),
      }),
    );
    const text = renderDoctorReport(report, { redacted: false });

    expect(text).toContain("cli_secret123");
    expect(text).toContain("All checks passed.");
  });
});

describe("keep-awake check (macOS)", () => {
  const orig = process.platform;
  const asDarwin = (): void => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  };
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: orig, configurable: true });
  });
  const envWith = (extra: [string, string][]) =>
    new Map<string, string>([["TELEGRAM_BOT_TOKEN", VALID_TOKEN], ...extra]);

  it("flag on + caffeinate live → ok 'on and active'", async () => {
    asDarwin();
    const report = await runDoctorChecks(
      healthyProbes({
        readEnv: () => envWith([["TCB_KEEP_AWAKE", "1"]]),
        caffeinateActive: async () => true,
      }),
    );
    expect(
      report.checks.some((c) => c.status === "ok" && c.text.includes("keep-awake on and active")),
    ).toBe(true);
  });

  it("flag on but caffeinate absent → info, not a failure", async () => {
    asDarwin();
    const report = await runDoctorChecks(
      healthyProbes({
        readEnv: () => envWith([["TCB_KEEP_AWAKE", "1"]]),
        caffeinateActive: async () => false,
      }),
    );
    expect(
      report.checks.some(
        (c) => c.status === "info" && c.text.includes("keep-awake on but no caffeinate"),
      ),
    ).toBe(true);
    expect(report.checks.some((c) => c.status === "bad" && c.text.includes("keep-awake"))).toBe(
      false,
    );
  });

  it("flag off → info 'keep-awake off'", async () => {
    asDarwin();
    const report = await runDoctorChecks(healthyProbes({ readEnv: () => envWith([]) }));
    expect(
      report.checks.some((c) => c.status === "info" && c.text.includes("keep-awake off")),
    ).toBe(true);
  });

  it("flag on + lid CLOSED + disablesleep off → fail (Mac will sleep)", async () => {
    asDarwin();
    const report = await runDoctorChecks(
      healthyProbes({
        readEnv: () => envWith([["TCB_KEEP_AWAKE", "1"]]),
        clamshellClosed: async () => true,
        sleepDisabled: async () => false,
      }),
    );
    expect(report.checks.some((c) => c.status === "bad" && c.text.includes("lid is CLOSED"))).toBe(
      true,
    );
    expect(report.failures).toBeGreaterThan(0);
  });

  it("flag on + lid closed + disablesleep ON → ok (clamshell covered)", async () => {
    asDarwin();
    const report = await runDoctorChecks(
      healthyProbes({
        readEnv: () => envWith([["TCB_KEEP_AWAKE", "1"]]),
        clamshellClosed: async () => true,
        sleepDisabled: async () => true,
      }),
    );
    expect(
      report.checks.some((c) => c.status === "ok" && c.text.includes("clamshell sleep disabled")),
    ).toBe(true);
    expect(report.checks.some((c) => c.status === "bad")).toBe(false);
  });

  it("flag on + lid open + disablesleep off → info, not a failure", async () => {
    asDarwin();
    const report = await runDoctorChecks(
      healthyProbes({
        readEnv: () => envWith([["TCB_KEEP_AWAKE", "1"]]),
        clamshellClosed: async () => false,
        sleepDisabled: async () => false,
      }),
    );
    expect(
      report.checks.some(
        (c) => c.status === "info" && c.text.includes("closing the lid will sleep"),
      ),
    ).toBe(true);
    expect(report.checks.some((c) => c.status === "bad")).toBe(false);
  });

  it("no lid (desktop) → no clamshell line", async () => {
    asDarwin();
    const report = await runDoctorChecks(
      healthyProbes({
        readEnv: () => envWith([["TCB_KEEP_AWAKE", "1"]]),
        clamshellClosed: async () => null,
      }),
    );
    expect(report.checks.some((c) => c.text.includes("lid"))).toBe(false);
  });
});
