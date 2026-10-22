import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function runCli(args: string[], stateDir: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, TCB_STATE_DIR: stateDir },
    encoding: "utf8",
  });
}

describe("CLI config and automation commands", () => {
  it("exposes safe config inspection and allowlisted config writes", () => {
    const stateDir = join(tmpdir(), `tcb-cli-config-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
    const envFile = join(stateDir, ".env");
    writeFileSync(
      envFile,
      "TELEGRAM_BOT_TOKEN=123456:abcdefghijklmnopqrstuvwxyzABCDE\nUI_LANG=zh\n",
    );

    const list = runCli(["config", "list", "--json"], stateDir);
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout)).toContainEqual(
      expect.objectContaining({ key: "TELEGRAM_BOT_TOKEN", value: "<redacted>" }),
    );

    const set = runCli(["config", "set", "UI_LANG", "en", "--json"], stateDir);
    expect(set.status).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({ key: "UI_LANG", value: "en", changed: true });
    expect(readFileSync(envFile, "utf8")).toContain("UI_LANG=en");
  });

  it("exposes automation status and pause through the real CLI entrypoint", () => {
    const stateDir = join(tmpdir(), `tcb-cli-automation-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
    const envFile = join(stateDir, ".env");
    writeFileSync(
      envFile,
      "LOOP_ENGINEERING_CONFIG_FILE=/tmp/loop.yml\nLOOP_ENGINEERING_TICK_MS=300000\n",
    );

    const status = runCli(["automation", "status", "--json"], stateDir);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toContainEqual(
      expect.objectContaining({ id: "loop", enabled: true, tickMs: 300000 }),
    );

    const pause = runCli(["automation", "pause", "loop", "--json"], stateDir);
    expect(pause.status).toBe(0);
    expect(JSON.parse(pause.stdout)).toMatchObject({ id: "loop", enabled: false });
    expect(readFileSync(envFile, "utf8")).toContain("LOOP_ENGINEERING_TICK_MS=0");
  });
});
