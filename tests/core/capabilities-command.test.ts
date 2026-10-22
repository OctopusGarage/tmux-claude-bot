import { describe, expect, it } from "vitest";
import { runCapabilitiesCommand } from "../../src/core/capabilities/command.js";

describe("runCapabilitiesCommand", () => {
  it("renders catalog, task status, install plan, and update plan as JSON", () => {
    expect(JSON.parse(runCapabilitiesCommand(["list", "--json"]).stdout ?? "[]")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "skill:mattpocock:improve-codebase-architecture" }),
      ]),
    );

    expect(
      JSON.parse(
        runCapabilitiesCommand(["status", "--task", "architecture", "--json"]).stdout ?? "{}",
      ),
    ).toMatchObject({ taskKind: "architecture" });

    expect(
      JSON.parse(runCapabilitiesCommand(["install", "--default", "--json"]).stdout ?? "{}"),
    ).toEqual(
      expect.objectContaining({
        scope: "default",
        approvedSkills: expect.arrayContaining([
          expect.objectContaining({ id: "improve-codebase-architecture" }),
        ]),
      }),
    );

    expect(
      JSON.parse(runCapabilitiesCommand(["update", "--default", "--json"]).stdout ?? "{}"),
    ).toEqual(
      expect.objectContaining({
        scope: "default",
        nextCommands: expect.arrayContaining(["tcb loop skills refresh <file> --write"]),
      }),
    );
  });

  it("renders human-readable output for empty or missing task dependencies", () => {
    const noDependency = runCapabilitiesCommand(["status", "--task", "bug-fix"]);
    expect(noDependency.exitCode).toBe(0);
    expect(noDependency.stdout).toContain("has no external capability dependencies");

    const install = runCapabilitiesCommand(["install", "--default"]);
    expect(install.exitCode).toBe(0);
    expect(install.stdout).toContain("capabilities install plan");

    const update = runCapabilitiesCommand(["update", "--default"]);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain("capabilities update plan");
  });

  it("rejects invalid options and unknown actions", () => {
    expect(runCapabilitiesCommand(["list", "--bad"])).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("unknown capabilities list option"),
    });
    expect(runCapabilitiesCommand(["status", "--task", "missing"])).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("Usage: capabilities status"),
    });
    expect(runCapabilitiesCommand(["install"])).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("Usage: capabilities install"),
    });
    expect(runCapabilitiesCommand(["update"])).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("Usage: capabilities update"),
    });
    expect(runCapabilitiesCommand(["wat"])).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("Usage: capabilities list"),
    });
  });
});
