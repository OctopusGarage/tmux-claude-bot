import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(__dirname, "..");

type Workflow = {
  on: {
    push: { branches: string[] };
    pull_request: { branches: string[] };
  };
};

const readWorkflow = (): Workflow =>
  parse(readFileSync(join(root, ".github/workflows/gitleaks.yml"), "utf8")) as Workflow;

describe("Gitleaks workflow", () => {
  it("scans both main and dev lanes where project PRs and dependency automation land", () => {
    const workflow = readWorkflow();

    expect(workflow.on.push.branches).toEqual(expect.arrayContaining(["main", "dev"]));
    expect(workflow.on.pull_request.branches).toEqual(expect.arrayContaining(["main", "dev"]));
  });
});
