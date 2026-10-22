import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

const TSX = nodePath.resolve("node_modules/.bin/tsx");
const HELPER = nodePath.resolve("tests/helpers/config-env-writer.ts");
const AUTOMATION_HELPER = nodePath.resolve("tests/helpers/automation-toggle.ts");
const processes: ChildProcess[] = [];
const temporaryDirectories: string[] = [];

function createTemporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function spawnWriter(stateDir: string, key: string, value: string): ChildProcess {
  const child = spawn(TSX, [HELPER, key, value], {
    env: { ...process.env, TCB_STATE_DIR: stateDir },
    stdio: ["ignore", "pipe", "inherit"],
  });
  processes.push(child);
  return child;
}

function spawnAutomationPause(stateDir: string, target: string): ChildProcess {
  const child = spawn(TSX, [AUTOMATION_HELPER, target], {
    env: { ...process.env, TCB_STATE_DIR: stateDir },
    stdio: ["ignore", "pipe", "inherit"],
  });
  processes.push(child);
  return child;
}

function waitForOutput(child: ChildProcess, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(token)) resolve();
    });
    child.on("exit", () =>
      output.includes(token) ? resolve() : reject(new Error(`missing ${token}: ${output}`)),
    );
    child.on("error", reject);
  });
}

function collect(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("exit", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`writer exited ${code}: ${output}`)),
    );
    child.on("error", reject);
  });
}

afterEach(() => {
  for (const child of processes.splice(0)) child.kill("SIGKILL");
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("config environment cross-process lock", () => {
  it("waits for the current writer and then merges onto its durable contents", async () => {
    const dir = createTemporaryDirectory("tcb-config-lock-");
    const envPath = nodePath.join(dir, ".env");
    const lockPath = nodePath.join(dir, ".env.lock");
    fs.writeFileSync(envPath, "FIRST=1\n");
    fs.mkdirSync(lockPath);

    const writer = spawnWriter(dir, "SECOND", "2");
    const completion = collect(writer);
    await waitForOutput(writer, "STARTING");
    await sleep(150);
    expect(writer.exitCode).toBeNull();
    expect(fs.readFileSync(envPath, "utf8")).toBe("FIRST=1\n");

    fs.rmSync(lockPath, { recursive: true });
    expect(await completion).toContain("WROTE");
    expect(fs.readFileSync(envPath, "utf8")).toContain("FIRST=1");
    expect(fs.readFileSync(envPath, "utf8")).toContain("SECOND=2");
  }, 30_000);

  it("recovers an abandoned lock after its bounded stale interval", async () => {
    const dir = createTemporaryDirectory("tcb-config-stale-lock-");
    const lockPath = nodePath.join(dir, ".env.lock");
    fs.writeFileSync(nodePath.join(dir, ".env"), "FIRST=1\n");
    fs.mkdirSync(lockPath);
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, stale, stale);

    const writer = spawnWriter(dir, "SECOND", "2");

    expect(await collect(writer)).toContain("WROTE");
    expect(fs.readFileSync(nodePath.join(dir, ".env"), "utf8")).toContain("SECOND=2");
  }, 30_000);

  it("serializes automation recovery state with its environment update", async () => {
    const dir = createTemporaryDirectory("tcb-automation-lock-");
    const lockPath = nodePath.join(dir, ".env.lock");
    fs.writeFileSync(
      nodePath.join(dir, ".env"),
      [
        "LOOP_ENGINEERING_CONFIG_FILE=/tmp/loop.yml",
        "LOOP_ENGINEERING_TICK_MS=111",
        "TASK_AUDIT_ENABLED=true",
        "TASK_AUDIT_TICK_MS=222",
      ].join("\n"),
    );
    fs.mkdirSync(lockPath);

    const loop = spawnAutomationPause(dir, "loop");
    const audit = spawnAutomationPause(dir, "task-audit");
    const loopDone = collect(loop);
    const auditDone = collect(audit);
    await Promise.all([waitForOutput(loop, "STARTING"), waitForOutput(audit, "STARTING")]);
    await sleep(150);
    expect(fs.existsSync(nodePath.join(dir, "automation-pauses.json"))).toBe(false);

    fs.rmSync(lockPath, { recursive: true });
    expect(await loopDone).toContain("WROTE");
    expect(await auditDone).toContain("WROTE");
    expect(
      JSON.parse(fs.readFileSync(nodePath.join(dir, "automation-pauses.json"), "utf8")),
    ).toEqual(
      expect.objectContaining({
        loop: { LOOP_ENGINEERING_TICK_MS: "111" },
        "task-audit": { TASK_AUDIT_TICK_MS: "222", TASK_AUDIT_ENABLED: "true" },
      }),
    );
    const env = fs.readFileSync(nodePath.join(dir, ".env"), "utf8");
    expect(env).toContain("LOOP_ENGINEERING_TICK_MS=0");
    expect(env).toContain("TASK_AUDIT_ENABLED=false");
  }, 30_000);
});
