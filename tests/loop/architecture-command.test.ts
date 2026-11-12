import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runArchitectureCommand,
  runTaskImplementationCommand,
} from "../../src/core/loop/architecture-command.js";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";

function configFile() {
  const file = join(mkdtempSync(join(tmpdir(), "tcb-architecture-config-")), "loop.yaml");
  writeFileSync(
    file,
    `projects:
  - id: example
    name: Example
    path: /repo/example
    agent: codex
    goal: Improve bounded architecture.
    maxRounds: 2
    targetScore: 90
    runner: {kind: agent-supervised}
    execution: {agent: true}
    assessment: {command: pnpm assess}
`,
  );
  return file;
}

describe("architecture implementation configuration command", () => {
  it("shows native defaults and persists explicit opt-in without revealing params", () => {
    const file = configFile();
    expect(
      JSON.parse(
        runArchitectureCommand({ action: "get", file, projectId: "example" }).stdout ?? "null",
      ),
    ).toEqual({ projectId: "example", implementation: { kind: "native" } });
    const result = runArchitectureCommand({
      action: "set",
      file,
      projectId: "example",
      selection: {
        kind: "ralphworks",
        runtime: "/config/private-runtime.yaml",
        params: { focus: "private task detail", limit: 2 },
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("private task detail");
    expect(JSON.parse(result.stdout ?? "null").implementation.params).toEqual({
      focus: "<redacted>",
      limit: "<redacted>",
    });
    const project = parseLoopConfigYaml(readFileSync(file, "utf8")).projects[0];
    expect(project?.goal).toBe("Improve bounded architecture.");
    expect(project?.execution.architecture).toMatchObject({
      kind: "ralphworks",
      params: { limit: 2 },
    });
    expect(
      runArchitectureCommand({
        action: "set",
        file,
        projectId: "example",
        selection: { kind: "native" },
      }).exitCode,
    ).toBe(0);
  });

  it("rejects unknown projects, model credentials, and incompatible selections without writes", () => {
    const file = configFile();
    const before = readFileSync(file, "utf8");
    for (const selection of [
      { kind: "other" },
      { kind: "ralphworks", apiKey: "forbidden" },
      { kind: "ralphworks", params: { apiKey: "forbidden" } },
    ]) {
      expect(
        runArchitectureCommand({ action: "set", file, projectId: "example", selection }).exitCode,
      ).toBe(1);
      expect(readFileSync(file, "utf8")).toBe(before);
    }
    expect(runArchitectureCommand({ action: "get", file, projectId: "missing" }).exitCode).toBe(1);
  });
});

describe.each([
  ["architecture", "architecture"],
  ["bug-fix", "bugFix"],
  ["test-coverage", "testCoverage"],
  ["security-maintenance", "securityMaintenance"],
] as const)("%s implementation command", (taskKind, configKey) => {
  it("defaults to native and changes only the selected family, redacting params", () => {
    const file = configFile();
    expect(
      JSON.parse(
        runTaskImplementationCommand({ taskKind, action: "get", file, projectId: "example" })
          .stdout ?? "null",
      ),
    ).toEqual({ projectId: "example", implementation: { kind: "native" } });
    for (const otherKind of [
      "architecture",
      "bug-fix",
      "test-coverage",
      "security-maintenance",
    ] as const) {
      expect(
        runTaskImplementationCommand({
          taskKind: otherKind,
          action: "set",
          file,
          projectId: "example",
          selection: { kind: "ralphworks", params: { focus: "private detail" } },
        }).exitCode,
      ).toBe(0);
    }
    const read = runTaskImplementationCommand({
      taskKind,
      action: "get",
      file,
      projectId: "example",
    });
    expect(JSON.parse(read.stdout ?? "null").implementation.params).toEqual({
      focus: "<redacted>",
    });
    expect(read.stdout).not.toContain("private detail");
    expect(
      runTaskImplementationCommand({
        taskKind,
        action: "set",
        file,
        projectId: "example",
        selection: { kind: "native" },
      }).exitCode,
    ).toBe(0);
    const execution = parseLoopConfigYaml(readFileSync(file, "utf8")).projects[0]?.execution;
    expect(execution?.[configKey]).toEqual({ kind: "native" });
    for (const otherKey of [
      "architecture",
      "bugFix",
      "testCoverage",
      "securityMaintenance",
    ] as const) {
      if (otherKey !== configKey) expect(execution?.[otherKey]?.kind).toBe("ralphworks");
    }
  });

  it("rejects invalid selection, credentials, and unsupervised execution without writing", () => {
    const file = configFile();
    for (const replacement of [undefined, "runner: {kind: system}", "execution: {agent: false}"]) {
      if (replacement !== undefined)
        writeFileSync(
          file,
          readFileSync(configFile(), "utf8").replace(
            replacement.startsWith("runner")
              ? "runner: {kind: agent-supervised}"
              : "execution: {agent: true}",
            replacement,
          ),
        );
      const before = readFileSync(file, "utf8");
      const selections =
        replacement === undefined
          ? [
              { kind: "unknown" },
              { kind: "ralphworks", apiKey: "private-credential-value" },
              { kind: "ralphworks", params: { accessToken: "private-credential-value" } },
            ]
          : [{ kind: "ralphworks" }];
      for (const selection of selections) {
        const result = runTaskImplementationCommand({
          taskKind,
          action: "set",
          file,
          projectId: "example",
          selection,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).not.toContain("private-credential-value");
        expect(readFileSync(file, "utf8")).toBe(before);
      }
    }
  });
});

it("rejects unsupported implementation families without writing", () => {
  const file = configFile();
  const before = readFileSync(file, "utf8");
  expect(
    runTaskImplementationCommand({
      taskKind: "harness-auto" as never,
      action: "set",
      file,
      projectId: "example",
      selection: { kind: "ralphworks" },
    }).exitCode,
  ).toBe(1);
  expect(readFileSync(file, "utf8")).toBe(before);
});
