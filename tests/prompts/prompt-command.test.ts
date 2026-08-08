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

  it("returns machine-readable list, show, and check output for command adapters", () => {
    const list = runGovernedPromptsCommand(["list", "--json"]);
    const show = runGovernedPromptsCommand(["show", "loop.policy.test-coverage", "--json"]);
    const check = runGovernedPromptsCommand(["check", "--json"]);

    expect(list).toMatchObject({ exitCode: 0 });
    expect(show).toMatchObject({ exitCode: 0 });
    expect(check).toMatchObject({ exitCode: 0 });
    if (list.exitCode !== 0 || show.exitCode !== 0 || check.exitCode !== 0) {
      throw new Error("expected json command success");
    }
    expect(JSON.parse(list.stdout) as unknown[]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "loop.policy.test-coverage",
          actionScope: "pr-create",
        }),
      ]),
    );
    expect(JSON.parse(show.stdout)).toMatchObject({
      id: "loop.policy.test-coverage",
      evalExpectation: "contract-test",
    });
    expect(JSON.parse(check.stdout)).toMatchObject({
      ok: true,
      missingTaskKinds: [],
      readOnlyViolations: [],
    });
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

  it("renders the specialized supervisor, repository, and repair fixtures", () => {
    const finalization = runGovernedPromptsCommand(["render", "loop.supervisor.finalization"]);
    const revision = runGovernedPromptsCommand(["render", "loop.supervisor.revision"]);
    const runtimeRepair = runGovernedPromptsCommand(["render", "repair.runtime-guardian"]);
    const repositoryReview = runGovernedPromptsCommand([
      "render",
      "loop.policy.repository-pull-request-review",
    ]);
    const repositoryRepair = runGovernedPromptsCommand([
      "render",
      "loop.policy.repository-pull-request-repair",
    ]);
    const delegatedTask = runGovernedPromptsCommand([
      "render",
      "loop.policy.active-delegated-task",
    ]);

    for (const result of [
      finalization,
      revision,
      runtimeRepair,
      repositoryReview,
      repositoryRepair,
      delegatedTask,
    ]) {
      expect(result).toMatchObject({ exitCode: 0 });
    }
    if (
      finalization.exitCode !== 0 ||
      revision.exitCode !== 0 ||
      runtimeRepair.exitCode !== 0 ||
      repositoryReview.exitCode !== 0 ||
      repositoryRepair.exitCode !== 0 ||
      delegatedTask.exitCode !== 0
    ) {
      throw new Error("expected specialized prompt render success");
    }
    expect(finalization.stdout).toContain("previous output without final marker");
    expect(revision.stdout).toContain("reviewGate.decision is missing");
    expect(runtimeRepair.stdout).toContain("Runtime Guardian (fast-heal)");
    expect(repositoryReview.stdout).toContain("repository-pull-request-review");
    expect(repositoryRepair.stdout).toContain("repository-pr-repair");
    expect(delegatedTask.stdout).toContain("active-delegated-task");
  });

  it("validates render command shape before rendering a governed prompt", () => {
    expect(
      runGovernedPromptsCommand(["render", "loop.policy.test-coverage", "--bad"]),
    ).toMatchObject({
      exitCode: 1,
      stderr: 'unknown option "--bad"',
    });
    expect(
      runGovernedPromptsCommand(["render", "loop.policy.test-coverage", "--fixture"]),
    ).toMatchObject({
      exitCode: 1,
      stderr: "prompts governed render --fixture requires a name",
    });
    expect(
      runGovernedPromptsCommand(["render", "loop.policy.test-coverage", "extra"]),
    ).toMatchObject({
      exitCode: 1,
      stderr: "Usage: prompts governed render <prompt-id> [--fixture default] [--json]",
    });
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

  it("generates all-prompt eval tasks and validates eval command options", () => {
    const all = runGovernedPromptsCommand(["eval", "--all"]);
    const badOutput = runGovernedPromptsCommand(["eval", "--output"]);
    const badOption = runGovernedPromptsCommand(["eval", "--bad"]);
    const badPrompt = runGovernedPromptsCommand(["eval", "missing.prompt"]);

    expect(all).toMatchObject({ exitCode: 0 });
    if (all.exitCode !== 0) throw new Error(all.stderr);
    expect(all.stdout).toContain("Evaluate all governed system prompts");
    expect(all.stdout).toContain("loop.policy.test-coverage");
    expect(badOutput).toMatchObject({
      exitCode: 1,
      stderr: "prompts governed eval --output requires a file",
    });
    expect(badOption).toMatchObject({ exitCode: 1, stderr: 'unknown option "--bad"' });
    expect(badPrompt).toMatchObject({
      exitCode: 1,
      stderr: 'unknown governed prompt "missing.prompt"',
    });
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
