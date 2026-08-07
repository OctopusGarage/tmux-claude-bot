import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPromptEvalTask,
  buildPromptGovernanceCheck,
  runGovernedPromptsCommand,
} from "../../src/core/prompts/command.js";

describe("governed prompt command", () => {
  it("runs deterministic governance checks", () => {
    expect(buildPromptGovernanceCheck()).toMatchObject({
      ok: true,
      missingTaskKinds: [],
      readOnlyViolations: [],
      automationGovernanceAutoMergeAllowed: false,
    });
  });

  it("lists and shows prompt metadata", () => {
    const list = runGovernedPromptsCommand(["list"]);
    const show = runGovernedPromptsCommand(["show", "loop.policy.test-coverage"]);

    expect(list).toMatchObject({ exitCode: 0 });
    expect(list.stdout).toContain("governed prompts:");
    expect(show).toMatchObject({ exitCode: 0 });
    expect(show.stdout).toContain("Action scope: pr-create");
  });

  it("renders supported prompts and rejects unsupported fixtures", () => {
    const rendered = runGovernedPromptsCommand(["render", "loop.policy.workspace-architecture"]);
    const repair = runGovernedPromptsCommand(["render", "repair.daily-task-audit", "--json"]);
    const unsupported = runGovernedPromptsCommand(["render", "workflow.arch-loop"]);
    const badFixture = runGovernedPromptsCommand([
      "render",
      "loop.policy.test-coverage",
      "--fixture",
      "unknown",
    ]);

    expect(rendered).toMatchObject({ exitCode: 0 });
    expect(rendered.stdout).toContain("Workspace architecture task.");
    expect(repair).toMatchObject({ exitCode: 0 });
    if (repair.exitCode !== 0) throw new Error(repair.stderr);
    expect(JSON.parse(repair.stdout) as { prompt: string }).toMatchObject({
      prompt: expect.stringContaining("Daily scheduled task audit repair."),
    });
    expect(unsupported).toMatchObject({ exitCode: 1 });
    expect(unsupported.stderr).toContain("does not have a built-in render fixture");
    expect(badFixture).toMatchObject({ exitCode: 1 });
  });

  it("generates eval tasks and writes them to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-prompt-command-"));
    const output = join(dir, "eval.md");
    const result = runGovernedPromptsCommand([
      "eval",
      "loop.policy.test-coverage",
      "--output",
      output,
    ]);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toBe(readFileSync(output, "utf8").trimEnd());
    expect(result.stdout).toContain("Evaluate governed system prompt loop.policy.test-coverage");
  });

  it("rejects unknown options and unknown prompt ids", () => {
    expect(runGovernedPromptsCommand(["show", "missing"])).toMatchObject({ exitCode: 1 });
    expect(runGovernedPromptsCommand(["list", "--bad"])).toMatchObject({ exitCode: 1 });
    expect(runGovernedPromptsCommand(["eval"])).toMatchObject({ exitCode: 1 });
    expect(runGovernedPromptsCommand(["render"])).toMatchObject({ exitCode: 1 });
    expect(runGovernedPromptsCommand(["unknown"])).toMatchObject({ exitCode: 1 });
  });

  it("builds an all-prompts eval task", () => {
    const task = buildPromptEvalTask({ ids: ["loop.supervisor.main"], all: true });

    expect(task).toContain("Evaluate all governed system prompts");
    expect(task).toContain("loop.supervisor.main");
    expect(task).toContain("Stop decision");
  });
});
