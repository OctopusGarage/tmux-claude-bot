import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(__dirname, "..");

type Workflow = {
  jobs: {
    checks: {
      steps: Array<{ if?: string; run?: string }>;
    };
  };
};

const readWorkflow = (): Workflow =>
  parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as Workflow;

describe("CI workflow", () => {
  it("uses the bounded audit wrapper for dependency vulnerability checks", () => {
    const workflow = readWorkflow();
    const auditStep = workflow.jobs.checks.steps.find((step) => step.run?.includes("audit"));

    expect(auditStep).toEqual({
      run: "scripts/audit-high.sh",
      if: "matrix.os == 'ubuntu-latest'",
    });
  });
});
