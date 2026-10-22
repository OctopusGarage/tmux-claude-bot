import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(__dirname, "..");

type Job = {
  if?: string;
  needs?: string | string[];
  "continue-on-error"?: boolean;
  steps: Array<{
    if?: string;
    run?: string;
    env?: Record<string, string>;
    "continue-on-error"?: boolean;
  }>;
};
type Workflow = { jobs: { checks: Job; verify: Job; [name: string]: Job } };

const readWorkflow = (): Workflow =>
  parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as Workflow;

describe("CI workflow", () => {
  it("always aggregates every CI job without soft-failing", () => {
    const workflow = readWorkflow();
    const verify = workflow.jobs.verify;
    const needs = typeof verify.needs === "string" ? [verify.needs] : verify.needs;
    expect(needs?.slice().sort()).toEqual(
      Object.keys(workflow.jobs)
        .filter((name) => name !== "verify")
        .sort(),
    );
    expect(verify.if).toBe("always()");
    for (const job of Object.values(workflow.jobs)) {
      expect(job["continue-on-error"] ?? false).toBe(false);
      for (const step of job.steps) expect(step["continue-on-error"] ?? false).toBe(false);
    }
  });
  it.each([
    ["success", true],
    ["success success", true],
    ["failure", false],
    ["cancelled", false],
    ["skipped", false],
    ["neutral", false],
    ["success failure", false],
    ["success skipped", false],
    ["", false],
  ])("requires every aggregate result to succeed: %j", (results, passes) => {
    const steps = readWorkflow().jobs.verify.steps;
    const gate = steps.find((step) => step.env?.CI_CHECK_RESULTS !== undefined);
    expect(gate?.env?.CI_CHECK_RESULTS).toBe(`\${{ join(needs.*.result, ' ') }}`);
    const result = spawnSync("bash", ["-c", gate?.run ?? "exit 99"], {
      env: { ...process.env, CI_CHECK_RESULTS: results },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status === 0).toBe(passes);
  });

  it("uses the bounded audit wrapper for dependency vulnerability checks", () => {
    const workflow = readWorkflow();
    const auditStep = workflow.jobs.checks.steps.find((step) => step.run?.includes("audit"));

    expect(auditStep).toEqual({
      run: "scripts/audit-high.sh",
      if: "matrix.os == 'ubuntu-latest'",
    });
  });
});
