import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerPowerCommands } from "../../src/cli/power-commands.js";

describe("power command family", () => {
  it("registers the bounded status and schedule command tree", () => {
    const program = new Command();
    registerPowerCommands(program);
    expect(program.commands.map((command) => command.name())).toEqual(["power"]);
    expect(program.commands[0]?.commands.map((command) => command.name())).toEqual([
      "status",
      "schedule",
    ]);
    expect(program.commands[0]?.commands[1]?.commands.map((command) => command.name())).toEqual([
      "install",
      "remove",
    ]);
  });
});
