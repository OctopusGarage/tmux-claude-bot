import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerPowerCommands } from "../../src/cli/power-commands.js";

describe("power command family", () => {
  it("registers the bounded status, history, and schedule command tree", () => {
    const program = new Command();
    registerPowerCommands(program);
    expect(program.commands.map((command) => command.name())).toEqual(["power"]);
    expect(program.commands[0]?.commands.map((command) => command.name())).toEqual([
      "status",
      "history",
      "schedule",
    ]);
    expect(program.commands[0]?.commands[1]?.options.map((option) => option.long)).toEqual([
      "--since",
      "--json",
    ]);
    expect(program.commands[0]?.commands[2]?.commands.map((command) => command.name())).toEqual([
      "install",
      "remove",
    ]);
  });
});
