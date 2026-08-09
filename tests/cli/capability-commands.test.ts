import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCapabilityCommands } from "../../src/cli/capability-commands.js";

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function programWithCapabilityCommands(): Command {
  const program = new Command();
  program.exitOverride();
  registerCapabilityCommands(program);
  return program;
}

describe("capability command family", () => {
  it("registers the curated capability command tree", () => {
    const program = new Command();
    registerCapabilityCommands(program);
    expect(program.commands[0]?.commands.map((command) => command.name())).toEqual([
      "list",
      "status",
      "install",
      "update",
    ]);
  });

  it("executes JSON list and update actions through the registered command tree", async () => {
    const program = programWithCapabilityCommands();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await program.parseAsync(["node", "tcb", "capabilities", "list", "--json"], {
      from: "node",
    });
    await program.parseAsync(["node", "tcb", "capabilities", "update", "--default", "--json"], {
      from: "node",
    });

    expect(JSON.parse(log.mock.calls[0]?.[0] ?? "null")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "skill:mattpocock:improve-codebase-architecture" }),
      ]),
    );
    expect(JSON.parse(log.mock.calls[1]?.[0] ?? "null")).toEqual(
      expect.objectContaining({
        scope: "default",
        nextCommands: expect.arrayContaining(["tcb loop skills refresh <file> --write"]),
      }),
    );
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
