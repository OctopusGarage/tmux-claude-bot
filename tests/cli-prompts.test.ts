import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, TCB_STATE_DIR: mkdtempSync(join(tmpdir(), "tcb-prompts-cli-")) },
    encoding: "utf8",
  });
}

describe("CLI governed prompts command", () => {
  it("lists governed prompts as JSON", () => {
    const result = runCli(["prompts", "governed", "list", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const prompts = JSON.parse(result.stdout) as Array<{
      id: string;
      actionScope: string;
      evalExpectation: string;
    }>;
    expect(prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "loop.supervisor.main",
          actionScope: "auto-merge",
          evalExpectation: "contract-test",
        }),
        expect.objectContaining({
          id: "repair.runtime-guardian",
          actionScope: "commit",
        }),
      ]),
    );
  });

  it("shows a single governed prompt with source and safety metadata", () => {
    const result = runCli(["prompts", "governed", "show", "loop.policy.test-coverage"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("loop.policy.test-coverage");
    expect(result.stdout).toContain("src/core/loop/work-order.ts");
    expect(result.stdout).toContain("Action scope: pr-create");
    expect(result.stdout).toContain("Eval expectation: contract-test");
  });

  it("renders a governed prompt with a built-in fixture", () => {
    const result = runCli(["prompts", "governed", "render", "loop.policy.test-coverage"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Test coverage improvement task.");
    expect(result.stdout).toContain("Do not add padding tests");
    expect(result.stdout).toContain("[LOOP_SUPERVISOR_DONE:");
  });

  it("renders the main supervisor fixture without undefined identifiers", () => {
    const result = runCli(["prompts", "governed", "render", "loop.supervisor.main"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("1752643800000-supervisor-main");
    expect(result.stdout).not.toContain("undefined");
  });

  it("returns rendered prompt JSON", () => {
    const result = runCli(["prompts", "governed", "render", "repair.runtime-guardian", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const rendered = JSON.parse(result.stdout) as { id: string; fixture: string; prompt: string };
    expect(rendered).toMatchObject({
      id: "repair.runtime-guardian",
      fixture: "default",
    });
    expect(rendered.prompt).toContain("Runtime Guardian (fast-heal)");
  });

  it("does not pretend docs-only prompts have render fixtures", () => {
    const result = runCli(["prompts", "governed", "render", "workflow.arch-loop"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not have a built-in render fixture");
  });

  it("checks governed prompt metadata completeness", () => {
    const result = runCli(["prompts", "governed", "check", "--json"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const check = JSON.parse(result.stdout) as {
      ok: boolean;
      promptCount: number;
      missingTaskKinds: string[];
      readOnlyViolations: string[];
      automationGovernanceAutoMergeAllowed: boolean;
    };
    expect(check.ok).toBe(true);
    expect(check.promptCount).toBeGreaterThan(10);
    expect(check.missingTaskKinds).toEqual([]);
    expect(check.readOnlyViolations).toEqual([]);
    expect(check.automationGovernanceAutoMergeAllowed).toBe(false);
  });

  it("generates an active-agent AI eval prompt for all governed prompts", () => {
    const result = runCli(["prompts", "governed", "eval", "--all"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Evaluate all governed system prompts");
    expect(result.stdout).toContain("Do not call model-provider APIs");
    expect(result.stdout).toContain("docs/prompt-governance.md");
    expect(result.stdout).toContain("src/core/prompts/registry.ts");
    expect(result.stdout).toContain("loop.policy.test-coverage");
    expect(result.stdout).toContain("Overall score");
    expect(result.stdout).toContain("Stop decision");
  });
});
