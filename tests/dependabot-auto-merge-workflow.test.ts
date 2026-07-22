import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(__dirname, "..");

type Workflow = {
  jobs: {
    "auto-merge": {
      if?: string;
      steps: Array<{ name?: string; if?: string; run?: string; with?: Record<string, unknown> }>;
    };
  };
};

const readWorkflow = (): Workflow =>
  parse(
    readFileSync(join(root, ".github/workflows/dependabot-auto-merge.yml"), "utf8"),
  ) as Workflow;

describe("Dependabot auto-merge workflow", () => {
  it("keeps Dependabot PRs in the auto-merge lane even when GitHub opens security updates against main", () => {
    const workflow = readWorkflow();
    const job = workflow.jobs["auto-merge"];

    expect(job.if).toContain("github.event.pull_request.user.login == 'dependabot[bot]'");
    expect(job.if).toContain("github.event.pull_request.user.login == 'app/dependabot'");
    expect(job.if).not.toContain("github.event.pull_request.base.ref == 'dev'");
    expect(job.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Retarget Dependabot PR to dev",
          if: "github.event.pull_request.base.ref != 'dev'",
          run: expect.stringContaining('gh pr edit "$PR_URL" --base dev'),
        }),
      ]),
    );
  });

  it("enables squash auto-merge after retargeting and branch refresh for patch or minor updates", () => {
    const workflow = readWorkflow();
    const steps = workflow.jobs["auto-merge"].steps;
    const stepNames = steps.map((step) => step.name);

    expect(stepNames.indexOf("Retarget Dependabot PR to dev")).toBeLessThan(
      stepNames.indexOf("Fetch Dependabot metadata"),
    );
    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Fetch Dependabot metadata",
          with: expect.objectContaining({
            "skip-commit-verification": "true",
            "skip-verification": "true",
          }),
        }),
      ]),
    );
    expect(stepNames.indexOf("Refresh Dependabot branch from dev")).toBeLessThan(
      stepNames.indexOf("Enable auto-merge into dev"),
    );
    expect(workflow.jobs["auto-merge"].steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Enable auto-merge into dev",
          run: expect.stringContaining('gh pr merge --auto --squash "$PR_URL"'),
        }),
      ]),
    );
  });
});
