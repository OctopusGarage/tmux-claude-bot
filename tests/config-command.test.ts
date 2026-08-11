import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let previousStateDir: string | undefined;

function writeEnv(stateDir: string, text: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, ".env"), text);
}

function stdoutOf(result: { stdout?: string }): string {
  expect(result.stdout).toBeDefined();
  return result.stdout ?? "";
}

describe("config and automation commands", () => {
  beforeEach(() => {
    previousStateDir = process.env.TCB_STATE_DIR;
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = previousStateDir;
  });

  it("exposes config and automation commands through separate domain modules", async () => {
    const configModule = await import("../src/core/config/config-command.js");
    const automationModule = await import("../src/core/config/automation-command.js");
    const compatibilityModule = await import("../src/core/config/command.js");

    expect(compatibilityModule.runConfigCommand).toBe(configModule.runConfigCommand);
    expect(compatibilityModule.runAutomationCommand).toBe(automationModule.runAutomationCommand);
  });

  it("lists personal config with secrets redacted and rejects unsafe generic writes", async () => {
    const dir = join(tmpdir(), `tcb-config-command-test-${Date.now()}`);
    process.env.TCB_STATE_DIR = dir;
    writeEnv(
      dir,
      [
        "TELEGRAM_BOT_TOKEN=123456:abcdefghijklmnopqrstuvwxyzABCDE",
        "UI_LANG=zh",
        "LOOP_ENGINEERING_TICK_MS=300000",
      ].join("\n"),
    );
    const { runConfigCommand } = await import("../src/core/config/command.js");

    const list = runConfigCommand(["list", "--json"]);
    expect(list.exitCode).toBe(0);
    const entries = JSON.parse(stdoutOf(list)) as Array<{
      key: string;
      value: string;
      secret: boolean;
    }>;
    expect(entries).toContainEqual(
      expect.objectContaining({ key: "TELEGRAM_BOT_TOKEN", value: "<redacted>", secret: true }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ key: "UI_LANG", value: "zh", secret: false }),
    );

    const rejected = runConfigCommand(["set", "TELEGRAM_BOT_TOKEN", "leak"]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("not settable through generic config");

    const set = runConfigCommand(["set", "UI_LANG", "en", "--json"]);
    expect(set.exitCode).toBe(0);
    expect(JSON.parse(stdoutOf(set))).toMatchObject({
      key: "UI_LANG",
      value: "en",
      changed: true,
    });
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("UI_LANG=en");

    expect(runConfigCommand(["set", "RESOURCE_GUARDIAN_ENABLED", "true"]).exitCode).toBe(0);
    expect(runConfigCommand(["set", "RESOURCE_GUARDIAN_TICK_MS", "60000"]).exitCode).toBe(0);
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("RESOURCE_GUARDIAN_ENABLED=true");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("RESOURCE_GUARDIAN_TICK_MS=60000");
    expect(runConfigCommand(["set", "RESOURCE_GUARDIAN_ENABLED", "maybe"])).toMatchObject({
      exitCode: 1,
    });
    expect(runConfigCommand(["set", "RESOURCE_GUARDIAN_TICK_MS", "-1"])).toMatchObject({
      exitCode: 1,
    });
    expect(runConfigCommand(["set", "RESOURCE_GUARDIAN_TICK_MS", "1.5"])).toMatchObject({
      exitCode: 1,
    });
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("RESOURCE_GUARDIAN_TICK_MS=60000");
  });

  it("handles config get, text output, missing entries, and usage errors", async () => {
    const dir = join(tmpdir(), `tcb-config-command-edges-${Date.now()}`);
    process.env.TCB_STATE_DIR = dir;
    writeEnv(dir, "UI_LANG=zh\nLARK_APP_SECRET=super-secret\n");
    const { runConfigCommand } = await import("../src/core/config/command.js");

    expect(runConfigCommand(["list"]).stdout).toContain("UI_LANG=zh");
    expect(runConfigCommand(["get", "LARK_APP_SECRET"]).stdout).toBe("LARK_APP_SECRET=<redacted>");

    const missing = runConfigCommand(["get", "DOES_NOT_EXIST", "--json"]);
    expect(missing.exitCode).toBe(0);
    expect(JSON.parse(stdoutOf(missing))).toMatchObject({
      key: "DOES_NOT_EXIST",
      value: "",
      present: false,
    });

    expect(runConfigCommand(["list", "--bad"]).stderr).toContain('unknown option "--bad"');
    expect(runConfigCommand(["set", "UNKNOWN_KEY", "x"]).stderr).toContain(
      "not settable through generic config",
    );
    expect(runConfigCommand([]).stderr).toContain("Usage: config");
  });

  it("summarizes and toggles high-cost automation without losing previous tick values", async () => {
    const dir = join(tmpdir(), `tcb-automation-command-test-${Date.now()}`);
    process.env.TCB_STATE_DIR = dir;
    writeEnv(
      dir,
      [
        "LOOP_ENGINEERING_CONFIG_FILE=/tmp/loop.yml",
        "LOOP_ENGINEERING_TICK_MS=12345",
        "LOOP_SUPERVISOR_ENABLED=false",
        "TASK_AUDIT_ENABLED=true",
        "TASK_AUDIT_TICK_MS=23456",
        "RUNTIME_GUARDIAN_ENABLED=false",
        "RUNTIME_GUARDIAN_TICK_MS=34567",
        "BATCH_SCHEDULER_TICK_MS=45678",
      ].join("\n"),
    );
    const { runAutomationCommand } = await import("../src/core/config/command.js");

    const status = runAutomationCommand(["status", "--json"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(stdoutOf(status))).toEqual([
      expect.objectContaining({
        id: "loop",
        enabled: true,
        tickMs: 12345,
        dependencies: { LOOP_SUPERVISOR_ENABLED: false },
      }),
      expect.objectContaining({ id: "task-audit", enabled: true, tickMs: 23456 }),
      expect.objectContaining({ id: "runtime-guardian", enabled: false, tickMs: 34567 }),
      expect.objectContaining({ id: "batch", enabled: true, tickMs: 45678 }),
    ]);

    const pause = runAutomationCommand(["pause", "loop", "--json"]);
    expect(pause.exitCode).toBe(0);
    expect(JSON.parse(stdoutOf(pause))).toMatchObject({
      id: "loop",
      enabled: false,
      changed: true,
    });
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("LOOP_ENGINEERING_TICK_MS=0");

    const resume = runAutomationCommand(["resume", "loop", "--json"]);
    expect(resume.exitCode).toBe(0);
    expect(JSON.parse(stdoutOf(resume))).toMatchObject({
      id: "loop",
      enabled: true,
      changed: true,
    });
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("LOOP_ENGINEERING_TICK_MS=12345");
  });

  it("does not pause automation when its resume state cannot be persisted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-automation-pause-failure-"));
    process.env.TCB_STATE_DIR = dir;
    writeEnv(dir, "LOOP_ENGINEERING_CONFIG_FILE=/tmp/loop.yml\nLOOP_ENGINEERING_TICK_MS=12345\n");
    mkdirSync(join(dir, "automation-pauses.json"));
    const { runAutomationCommand } = await import("../src/core/config/command.js");

    try {
      expect(runAutomationCommand(["pause", "loop"]).exitCode).toBe(1);
      expect(readFileSync(join(dir, ".env"), "utf8")).toContain("LOOP_ENGINEERING_TICK_MS=12345");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows the Loop supervisor dependency to be changed through config commands", async () => {
    const dir = join(tmpdir(), `tcb-supervisor-config-test-${Date.now()}`);
    process.env.TCB_STATE_DIR = dir;
    writeEnv(dir, "LOOP_SUPERVISOR_ENABLED=false\n");
    const { runConfigCommand } = await import("../src/core/config/command.js");

    const supervisor = runConfigCommand(["set", "LOOP_SUPERVISOR_ENABLED", "true", "--json"]);
    expect(supervisor.exitCode).toBe(0);
    expect(JSON.parse(stdoutOf(supervisor))).toMatchObject({
      key: "LOOP_SUPERVISOR_ENABLED",
      value: "true",
      changed: true,
    });
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("LOOP_SUPERVISOR_ENABLED=true");
  });

  it("handles automation text output, disabled targets, unknown targets, and enable flags", async () => {
    const dir = join(tmpdir(), `tcb-automation-command-edges-${Date.now()}`);
    process.env.TCB_STATE_DIR = dir;
    writeEnv(
      dir,
      [
        "TASK_AUDIT_ENABLED=true",
        "TASK_AUDIT_TICK_MS=0",
        "RUNTIME_GUARDIAN_ENABLED=false",
        "RUNTIME_GUARDIAN_TICK_MS=34567",
      ].join("\n"),
    );
    const { runAutomationCommand } = await import("../src/core/config/command.js");

    expect(runAutomationCommand(["status"]).stdout).toContain("task-audit: disabled tickMs=0");
    expect(runAutomationCommand(["pause", "task-audit"]).stdout).toContain("automation pause");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("TASK_AUDIT_ENABLED=false");

    const resume = runAutomationCommand(["resume", "task-audit", "--json"]);
    expect(resume.exitCode).toBe(0);
    expect(JSON.parse(stdoutOf(resume))).toMatchObject({
      id: "task-audit",
      enabled: false,
      tickMs: 0,
    });

    expect(runAutomationCommand(["pause", "missing"]).stderr).toContain(
      'unknown automation target "missing"',
    );
    expect(runAutomationCommand(["pause"]).stderr).toContain("Usage: automation");
    expect(runAutomationCommand(["status", "--bad"]).stderr).toContain('unknown option "--bad"');
    expect(runAutomationCommand([]).stderr).toContain("Usage: automation");
  });
});
