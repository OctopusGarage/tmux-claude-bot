import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerResourceCommands } from "../../src/cli/resource-commands.js";

describe("resource CLI command family", () => {
  it("registers the bounded Resource Guardian command tree", () => {
    const program = new Command();
    registerResourceCommands(program);

    expect(program.commands.map((command) => command.name())).toEqual(["resource"]);
    expect(program.commands[0]?.commands.map((command) => command.name())).toEqual([
      "status",
      "incidents",
      "mode",
      "profile",
    ]);
  });
});
