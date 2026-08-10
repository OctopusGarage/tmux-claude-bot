import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigEnvironment, writeConfigEnvironment } from "../../src/core/config/env-store.js";
import { runResourceGuardianCommand } from "../../src/core/resource-guardian/command.js";
import {
  recoverResourceGuardianOperatorUpdate,
  resourceGuardianOperatorUpdatePath,
  writeResourceGuardianOperatorUpdate,
} from "../../src/core/resource-guardian/operator-update.js";
import { createResourceGuardianStore } from "../../src/core/resource-guardian/store.js";

const originalStateDir = process.env.TCB_STATE_DIR;
const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

function stateDir(): string {
  const directory = join(tmpdir(), `tcb-resource-command-${Date.now()}-${directories.length}`);
  directories.push(directory);
  process.env.TCB_STATE_DIR = directory;
  return directory;
}

function writeEnv(directory: string, text: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, ".env"), text);
}

describe("Resource Guardian operator command", () => {
  it("reports a secret-free, tildeified status and bounds incident output", () => {
    const directory = stateDir();
    writeEnv(
      directory,
      "RESOURCE_GUARDIAN_ENABLED=true\nRESOURCE_GUARDIAN_TICK_MS=15000\nRESOURCE_GUARDIAN_MODE=protect\nRESOURCE_GUARDIAN_PROFILE=conservative\n",
    );
    const store = createResourceGuardianStore({ stateDir: directory, now: () => 10 });
    store.writeIncident({
      schemaVersion: 1,
      id: "incident-1",
      fingerprint: "fp",
      attribution: "bot-owned",
      startedAt: 1,
      endedAt: 2,
      pressure: "critical",
      samples: [
        {
          capturedAt: 1,
          hostCpuPct: 95,
          loadPct: 90,
          eventLoopLagMs: 12,
          thermal: "normal",
          deepSnapshot: {
            capturedAt: 1,
            thermal: "normal",
            processes: [
              {
                pid: 123,
                ppid: 1,
                pgid: 123,
                startedAt: "2026-08-09T00:00:00Z",
                cpuPct: 90,
                rssKb: 1_024,
                command: "worker --token super-secret",
                cwd: `${homedir()}/work`,
              },
            ],
          },
        },
      ],
      transitions: [],
      actions: [
        {
          kind: "resource-action",
          at: 2,
          outcome: "failed",
          reason: `${homedir()}/work token=super-secret`,
        },
      ],
    });

    const status = runResourceGuardianCommand(["status", "--json"]);
    const incidents = runResourceGuardianCommand(["incidents", "--limit", "1", "--json"]);

    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout ?? "{}")).toMatchObject({
      enabled: true,
      tickMs: 15000,
      view: { circuit: "open", mode: "protect", profile: "conservative" },
    });
    expect(incidents.exitCode).toBe(0);
    expect(JSON.parse(incidents.stdout ?? "[]")).toEqual([
      expect.objectContaining({ id: "incident-1" }),
    ]);
    expect(incidents.stdout).not.toContain(homedir());
    expect(incidents.stdout).toContain("~/work");
    expect(incidents.stdout).not.toContain("super-secret");
    expect(incidents.stdout).not.toContain("command");
    expect(incidents.stdout).not.toContain("cwd");
    expect(runResourceGuardianCommand(["incidents", "--limit", "0"])).toMatchObject({
      exitCode: 1,
    });
  });

  it("writes dedicated mode/profile config and matching live override, while protect requires enablement", () => {
    const directory = stateDir();
    writeEnv(directory, "RESOURCE_GUARDIAN_ENABLED=false\n");

    expect(runResourceGuardianCommand(["mode", "protect"])).toMatchObject({ exitCode: 1 });
    expect(runResourceGuardianCommand(["mode", "invalid"])).toMatchObject({ exitCode: 1 });
    expect(runResourceGuardianCommand(["profile", "invalid"])).toMatchObject({ exitCode: 1 });

    writeEnv(directory, "RESOURCE_GUARDIAN_ENABLED=true\n");
    const enabledStore = createResourceGuardianStore({ stateDir: directory });
    const enabledCurrent = enabledStore.readCurrentReadOnly();
    enabledStore.writeCurrent({
      circuit: enabledCurrent.circuit,
      view: { ...enabledCurrent.view, enabled: true },
    });
    expect(runResourceGuardianCommand(["mode", "protect", "--json"])).toMatchObject({
      exitCode: 0,
    });
    expect(runResourceGuardianCommand(["profile", "conservative"])).toMatchObject({ exitCode: 0 });
    expect(readFileSync(join(directory, ".env"), "utf8")).toContain(
      "RESOURCE_GUARDIAN_MODE=protect",
    );
    expect(readFileSync(join(directory, ".env"), "utf8")).toContain(
      "RESOURCE_GUARDIAN_PROFILE=conservative",
    );
    expect(createResourceGuardianStore({ stateDir: directory }).readOperator()).toMatchObject({
      mode: "protect",
      profile: "conservative",
    });
    expect(
      JSON.parse(runResourceGuardianCommand(["status", "--json"]).stdout ?? "{}"),
    ).toMatchObject({
      view: { mode: "protect", profile: "conservative" },
    });

    writeEnv(directory, "RESOURCE_GUARDIAN_ENABLED=true\nRESOURCE_GUARDIAN_TICK_MS=0\n");
    expect(runResourceGuardianCommand(["mode", "protect"])).toMatchObject({ exitCode: 1 });
    expect(
      JSON.parse(runResourceGuardianCommand(["status", "--json"]).stdout ?? "{}"),
    ).toMatchObject({
      enabled: false,
      tickMs: 0,
    });
  });

  it("recovers a durable config update when the matching live override write is interrupted", () => {
    const directory = stateDir();
    writeEnv(
      directory,
      "RESOURCE_GUARDIAN_ENABLED=true\nRESOURCE_GUARDIAN_MODE=observe\nRESOURCE_GUARDIAN_PROFILE=balanced\n",
    );
    const store = createResourceGuardianStore({ stateDir: directory });
    const current = store.readCurrentReadOnly();
    store.writeCurrent({
      circuit: current.circuit,
      view: { ...current.view, enabled: true },
    });
    const result = runResourceGuardianCommand(["mode", "protect"], {
      store: {
        ...store,
        writeOperator: vi.fn(() => {
          throw new Error("operator unavailable");
        }),
      },
    });

    expect(result).toMatchObject({ exitCode: 1 });
    expect(readFileSync(join(directory, ".env"), "utf8")).toContain(
      "RESOURCE_GUARDIAN_MODE=protect",
    );
    expect(store.readOperator()).toBeNull();
    expect(readFileSync(resourceGuardianOperatorUpdatePath(store), "utf8")).toContain(
      "RESOURCE_GUARDIAN_MODE",
    );

    expect(
      recoverResourceGuardianOperatorUpdate({
        store,
        readEnvironment: readConfigEnvironment,
      }),
    ).toBe("applied");
    expect(store.readOperator()).toMatchObject({ mode: "protect", profile: "balanced" });
    expect(() => readFileSync(resourceGuardianOperatorUpdatePath(store), "utf8")).toThrow();
  });

  it("uses the application default tick for a blank configured value", () => {
    const directory = stateDir();
    writeEnv(directory, "RESOURCE_GUARDIAN_ENABLED=true\nRESOURCE_GUARDIAN_TICK_MS=\n");

    expect(
      JSON.parse(runResourceGuardianCommand(["status", "--json"]).stdout ?? "{}"),
    ).toMatchObject({
      enabled: true,
      tickMs: 15_000,
    });
  });

  it("discards a prepared operator intent when config was never committed", () => {
    const directory = stateDir();
    writeEnv(directory, "RESOURCE_GUARDIAN_MODE=observe\n");
    const store = createResourceGuardianStore({ stateDir: directory });

    expect(() =>
      writeResourceGuardianOperatorUpdate({
        store,
        key: "RESOURCE_GUARDIAN_MODE",
        value: "protect",
        readEnvironment: readConfigEnvironment,
        writeEnvironment: () => {
          throw new Error("config unavailable");
        },
        now: 1,
      }),
    ).toThrow("config unavailable");

    expect(
      recoverResourceGuardianOperatorUpdate({
        store,
        readEnvironment: readConfigEnvironment,
      }),
    ).toBe("discarded");
    expect(store.readOperator()).toBeNull();
    expect(() => readFileSync(resourceGuardianOperatorUpdatePath(store), "utf8")).toThrow();
  });

  it("serializes overlapping operator commands with an inter-process lock", () => {
    const directory = stateDir();
    writeEnv(directory, "RESOURCE_GUARDIAN_MODE=observe\nRESOURCE_GUARDIAN_PROFILE=balanced\n");
    const store = createResourceGuardianStore({ stateDir: directory });
    const overlapping = vi.fn(() =>
      writeResourceGuardianOperatorUpdate({
        store,
        key: "RESOURCE_GUARDIAN_PROFILE",
        value: "conservative",
        readEnvironment: readConfigEnvironment,
        writeEnvironment: writeConfigEnvironment,
        now: 2,
      }),
    );

    writeResourceGuardianOperatorUpdate({
      store,
      key: "RESOURCE_GUARDIAN_MODE",
      value: "protect",
      readEnvironment: readConfigEnvironment,
      writeEnvironment: (values) => {
        writeConfigEnvironment(values);
        expect(
          recoverResourceGuardianOperatorUpdate({
            store,
            readEnvironment: readConfigEnvironment,
            now: 2,
          }),
        ).toBe("busy");
        expect(overlapping).toThrow("operator update is in progress");
      },
      now: 1,
    });

    const env = readConfigEnvironment();
    expect(env.get("RESOURCE_GUARDIAN_MODE")).toBe("protect");
    expect(env.get("RESOURCE_GUARDIAN_PROFILE")).toBe("balanced");
    expect(store.readOperator()).toMatchObject({ mode: "protect", profile: "balanced" });
    expect(overlapping).toHaveBeenCalledTimes(1);
  });

  it("takes over a live reused pid but preserves the matching process generation", () => {
    const directory = stateDir();
    const store = createResourceGuardianStore({ stateDir: directory });
    const lock = `${store.paths.operator}.lock`;
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        token: "old-generation",
        pid: process.pid,
        processStartedAt: "Sun Aug  9 00:00:00 2026",
        createdAt: Date.now(),
      })}\n`,
    );

    expect(
      recoverResourceGuardianOperatorUpdate({
        store,
        readEnvironment: readConfigEnvironment,
        isProcessAlive: () => true,
        readProcessStartedAt: () => "Sun Aug  9 00:00:01 2026",
      }),
    ).toBe("none");

    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        token: "current-generation",
        pid: process.pid,
        processStartedAt: "Sun Aug  9 00:00:02 2026",
        createdAt: Date.now(),
      })}\n`,
    );
    expect(
      recoverResourceGuardianOperatorUpdate({
        store,
        readEnvironment: readConfigEnvironment,
        isProcessAlive: () => true,
        readProcessStartedAt: () => "Sun Aug  9 00:00:02 2026",
      }),
    ).toBe("busy");
  });
});
