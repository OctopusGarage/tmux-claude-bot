import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerConfigurationCommands } from "../../src/cli/configuration-commands.js";

const originalStateDir = process.env.TCB_STATE_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

function programWithConfigurationCommands(): Command {
  const program = new Command();
  program.exitOverride();
  registerConfigurationCommands(program);
  return program;
}

function isolatedStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tcb-cli-config-"));
  tempDirs.push(dir);
  process.env.TCB_STATE_DIR = dir;
  return dir;
}

describe("configuration command family", () => {
  it("registers the safe configuration and automation command trees", () => {
    const program = new Command();

    registerConfigurationCommands(program);

    expect(program.commands.map((command) => command.name())).toEqual(["config", "automation"]);
    expect(program.commands[0]?.commands.map((command) => command.name())).toEqual([
      "list",
      "get",
      "set",
    ]);
    expect(program.commands[1]?.commands.map((command) => command.name())).toEqual([
      "status",
      "pause",
      "resume",
    ]);
  });

  it("executes read-only config and automation JSON commands through the registered actions", async () => {
    isolatedStateDir();
    const program = programWithConfigurationCommands();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await program.parseAsync(["node", "tcb", "config", "list", "--json"], { from: "node" });
    await program.parseAsync(["node", "tcb", "automation", "status", "--json"], {
      from: "node",
    });

    expect(JSON.parse(log.mock.calls[0]?.[0] ?? "null")).toEqual([]);
    expect(JSON.parse(log.mock.calls[1]?.[0] ?? "null")).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "loop" })]),
    );
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
