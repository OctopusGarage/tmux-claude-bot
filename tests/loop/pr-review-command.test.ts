import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";
import { runPrReviewerCommand } from "../../src/core/loop/pr-review-command.js";

const yaml = `projects:
  - id: fixture
    name: Fixture
    path: /repo/fixture
    agent: codex
    goal: Repair verified bugs.
    maxRounds: 2
    targetScore: 90
    runner: {kind: agent-supervised}
    execution: {agent: true}
    assessment: {command: pnpm assess}
prReview:
  repositories:
    - id: fixture
      name: Fixture
      path: /repo/fixture
      repo: example/fixture
      agent: codex
      schedule: "0 2 * * *"
`;
const fixture = (text = yaml) => {
  const file = join(mkdtempSync(join(tmpdir(), "tcb-pr-review-command-")), "loop.yaml");
  writeFileSync(file, text);
  return file;
};

describe.each(["project", "repository"])("%s PR reviewer selection", (scope) => {
  it("defaults independently to native, redacts params, and round-trips the selected reviewer", () => {
    const file = fixture();
    const input = { file, scope, id: "fixture" };
    expect(
      JSON.parse(runPrReviewerCommand({ ...input, action: "get" }).stdout ?? "null").reviewer,
    ).toEqual({ kind: "native" });
    expect(
      runPrReviewerCommand({
        ...input,
        action: "set",
        selection: { kind: "ralphworks", params: { focus: "private detail", strict: true } },
      }).exitCode,
    ).toBe(0);
    const output = runPrReviewerCommand({ ...input, action: "get" }).stdout;
    expect(output).not.toContain("private detail");
    expect(JSON.parse(output ?? "null").reviewer.params).toEqual({
      focus: "<redacted>",
      strict: "<redacted>",
    });
    const parsed = parseLoopConfigYaml(readFileSync(file, "utf8"));
    expect(
      scope === "project"
        ? parsed.prReview.repositories[0]?.reviewer
        : parsed.projects[0]?.pullRequestReview.reviewer,
    ).toBeUndefined();
    expect(
      runPrReviewerCommand({ ...input, action: "set", selection: { kind: "native" } }).exitCode,
    ).toBe(0);
  });
  it("rejects malformed or credential-bearing selections without writes", () => {
    const file = fixture();
    const before = readFileSync(file, "utf8");
    for (const selection of [
      { kind: "ralphworks", apiKey: "private-secret" },
      { kind: "ralphworks", params: { accessToken: "private-secret" } },
      { kind: "ralphworks", params: { nested: { enabled: true } } },
      { kind: "native", profile: "custom" },
      { kind: "unknown" },
    ]) {
      const result = runPrReviewerCommand({ action: "set", file, scope, id: "fixture", selection });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toContain("private-secret");
      expect(readFileSync(file, "utf8")).toBe(before);
    }
  });
});

it("rejects workspace scope, missing identity, ambiguity and unsupervised external selection without writes", () => {
  for (const [scope, id, text] of [
    ["workspace", "fixture", yaml],
    ["project", "unknown", yaml],
    ["project", "fixture", yaml.replace("agent: true", "agent: false")],
    ["project", "fixture", yaml.replace("kind: agent-supervised", "kind: system")],
    [
      "project",
      "fixture",
      yaml.replace(
        "prReview:",
        `${yaml.slice(0, yaml.indexOf("prReview:")).replace("projects:\n", "")}prReview:`,
      ),
    ],
  ] as const) {
    const file = fixture(text);
    const before = readFileSync(file, "utf8");
    expect(
      runPrReviewerCommand({
        action: "set",
        file,
        scope: scope ?? "",
        id: id ?? "",
        selection: { kind: "ralphworks" },
      }).exitCode,
    ).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(before);
  }
});
