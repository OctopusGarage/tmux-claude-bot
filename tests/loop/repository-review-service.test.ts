import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryReviewQueue } from "../../src/core/loop/repository-review-queue.js";
import { LoopSchedulerStore } from "../../src/core/loop/scheduler.js";
import { runLoopServiceTickAsync } from "../../src/core/loop/service.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("repository review service queue", () => {
  it("persists a due repository review without waiting for a supervisor", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-pr-review-service-"));
    const root = mkdtempSync(join(tmpdir(), "tcb-pr-review-repo-"));
    const configFile = join(root, "loop.yml");
    writeFileSync(
      configFile,
      `
projects:
  - id: placeholder
    name: Placeholder
    path: ${root}
    agent: codex
    goal: Keep the placeholder valid.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "true"
    execution:
      agent: true
    allowedActions: [tests]
prReview:
  repositories:
    - id: repo-prs
      name: Repository PRs
      path: ${root}
      repo: OctopusGarage/repo
      agent: codex
      schedule: "* * * * *"
      switchBack: main
      runner:
        kind: agent-supervised
`,
    );

    const result = await runLoopServiceTickAsync({
      configFile,
      now: Date.parse("2026-08-07T00:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("repository review should not wait for a supervisor");
      },
      supervisorSessionNames: [],
      repositoryReviewOnly: true,
    });

    expect(result).toMatchObject({ due: 1, ran: 0, failed: 0 });
    expect(new RepositoryReviewQueue().list()).toEqual([
      expect.objectContaining({
        repositoryId: "repo-prs",
        status: "pending",
      }),
    ]);
  });
});
