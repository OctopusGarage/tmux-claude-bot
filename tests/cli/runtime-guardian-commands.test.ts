import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import {
  cmdRuntimeGuardianFindings,
  registerRuntimeGuardianCommands,
} from "../../src/cli/runtime-guardian-commands.js";

describe("runtime-guardian CLI command family", () => {
  it("registers the read-only findings drilldown", () => {
    const program = new Command();
    registerRuntimeGuardianCommands(program);

    expect(program.commands.map((command) => command.name())).toEqual(["runtime-guardian"]);
    expect(program.commands[0]?.commands.map((command) => command.name())).toEqual(["findings"]);
  });

  it("passes parsed findings options to the command runner", async () => {
    const program = new Command();
    const runFindings = vi.fn(async () => undefined);
    registerRuntimeGuardianCommands(program, runFindings);

    await program.parseAsync(
      ["runtime-guardian", "findings", "--project", "alpha", "--limit", "20"],
      { from: "user" },
    );

    expect(runFindings).toHaveBeenCalledWith(
      expect.objectContaining({ project: "alpha", limit: "20" }),
    );
  });
});

describe("cmdRuntimeGuardianFindings", () => {
  it("prints text findings from the Control seam", async () => {
    const stdout = vi.fn();
    const runtimeGuardianFindings = vi.fn(async () => ({
      observedAt: 2_000,
      lookbackHours: 24,
      limit: 20,
      total: 1,
      truncated: false,
      findings: [
        {
          kind: "terminal-invalid-output" as const,
          severity: "high" as const,
          runId: "run-1",
          projectId: "alpha",
          projectPath: "/synthetic/alpha",
          evidence: ["final summary was invalid"],
        },
      ],
    }));

    await cmdRuntimeGuardianFindings(
      { project: "alpha", limit: "20" },
      {
        stdout,
        withClient: async (fn) =>
          fn({
            runtimeGuardianFindings,
          } as never),
      },
    );

    expect(runtimeGuardianFindings).toHaveBeenCalledWith({ projectId: "alpha", limit: 20 });
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("alpha · terminal-invalid-output"));
  });

  it("prints tilde-safe JSON findings", async () => {
    const stdout = vi.fn();

    await cmdRuntimeGuardianFindings(
      { json: true, lookbackHours: "48" },
      {
        stdout,
        withClient: async (fn) =>
          fn({
            runtimeGuardianFindings: vi.fn(async () => ({
              observedAt: 2_000,
              lookbackHours: 48,
              limit: 20,
              total: 0,
              truncated: false,
              findings: [],
            })),
          } as never),
      },
    );

    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"lookbackHours": 48'));
  });

  it("reports option parse errors through the CLI failure path", async () => {
    const stderr = vi.fn();
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });

    await expect(
      cmdRuntimeGuardianFindings(
        { limit: "0" },
        {
          stderr,
          exit,
          withClient: async (fn) =>
            fn({
              runtimeGuardianFindings: vi.fn(),
            } as never),
        },
      ),
    ).rejects.toThrow("exit 1");

    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("--limit must be a positive integer"),
    );
  });
});
