import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerArchitectureCommands } from "../../src/cli/architecture-commands.js";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";

describe("architecture CLI", () => {
  it.each([
    ["architecture", "architecture"],
    ["bugfix", "bugFix"],
    ["test-coverage", "testCoverage"],
    ["security-maintenance", "securityMaintenance"],
  ] as const)(
    "%s accepts primitive params and redacts configuration",
    async (command, configKey) => {
      const file = join(mkdtempSync(join(tmpdir(), "tcb-architecture-cli-")), "loop.yaml");
      writeFileSync(
        file,
        `projects:
  - id: fixture
    name: Fixture
    path: /repo/fixture
    agent: codex
    goal: Reduce coupling.
    maxRounds: 2
    targetScore: 90
    runner: {kind: agent-supervised}
    execution: {agent: true}
    assessment: {command: pnpm assess}
`,
      );
      const program = new Command();
      registerArchitectureCommands(program.command("loop"));
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await program.parseAsync(
          [
            "loop",
            command,
            "set",
            file,
            "fixture",
            "ralphworks",
            "--profile",
            "custom-params-fixture",
            "--param",
            "maxFindings=2",
            "--param",
            "strict=true",
            "--param",
            "focus=parser",
          ],
          { from: "user" },
        );
        expect(
          parseLoopConfigYaml(readFileSync(file, "utf8")).projects[0]?.execution[configKey],
        ).toMatchObject({
          kind: "ralphworks",
          params: { maxFindings: 2, strict: true, focus: "parser" },
        });
        expect(output).toHaveBeenCalledWith(expect.not.stringContaining("parser"));
        output.mockClear();
        await program.parseAsync(["loop", command, "get", file, "fixture"], { from: "user" });
        expect(JSON.parse(String(output.mock.calls[0]?.[0])).implementation.params).toEqual({
          maxFindings: "<redacted>",
          strict: "<redacted>",
          focus: "<redacted>",
        });
        await program.parseAsync(["loop", command, "set", file, "fixture", "native"], {
          from: "user",
        });
        expect(
          parseLoopConfigYaml(readFileSync(file, "utf8")).projects[0]?.execution[configKey],
        ).toEqual({ kind: "native" });
      } finally {
        output.mockRestore();
      }
    },
  );
});

it("keeps shared quarantine controls available under all implementation families", () => {
  const loop = new Command();
  registerArchitectureCommands(loop);
  for (const name of ["architecture", "bugfix", "test-coverage", "security-maintenance"]) {
    const quarantine = loop.commands
      .find((command) => command.name() === name)
      ?.commands.find((command) => command.name() === "quarantine");
    expect(quarantine?.commands.map((command) => command.name())).toEqual(["list", "release"]);
  }
});
