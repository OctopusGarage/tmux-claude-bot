import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryReviewQueue } from "../../src/core/loop/repository-review-queue.js";
import { LoopSchedulerStore } from "../../src/core/loop/scheduler.js";
import {
  reconcileRepositoryReviewQueueLedgerClosures,
  runLoopServiceTickAsync as runLoopServiceTickAsyncProduction,
} from "../../src/core/loop/service.js";
import { DailyTaskLedger } from "../../src/core/tasks/task-ledger.js";

const originalStateDir = process.env.TCB_STATE_DIR;

const runLoopServiceTickAsync = async (
  input: Parameters<typeof runLoopServiceTickAsyncProduction>[0],
) => {
  const text = readFileSync(input.configFile, "utf8");
  if (!/^scheduler:/m.test(text)) {
    writeFileSync(input.configFile, `scheduler:\n  jitter:\n    enabled: false\n${text}`);
  }
  return runLoopServiceTickAsyncProduction(input);
};

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("repository review service queue", () => {
  it("closes retryable repository review queue items from fixed daily ledger evidence", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-pr-review-service-"));
    const queue = new RepositoryReviewQueue();
    const ledger = new DailyTaskLedger();
    const scheduledAt = 1787198400000;
    const created = queue.enqueue({
      repositoryId: "tmux-claude-bot-all-prs",
      scheduledAt,
      priority: 1000,
      now: 100,
    });

    expect(queue.lease(created.id, "worker", 100, 100)).not.toBeNull();
    expect(
      queue.fail(
        created.id,
        "worker",
        110,
        "recovered supervisor work order result: supervisor-failed",
        200,
      ),
    ).toBe(true);
    ledger.expect({
      taskId: `loop:pr-review:tmux-claude-bot-all-prs:${scheduledAt}`,
      source: "loop-engineering",
      name: "tmux-claude-bot-all-prs repository-pull-request-review",
      scheduledAt,
    });
    ledger.fail(`loop:pr-review:tmux-claude-bot-all-prs:${scheduledAt}`, {
      endedAt: 120,
      error: "supervisor-failed",
    });
    ledger.markRepairStatus(`loop:pr-review:tmux-claude-bot-all-prs:${scheduledAt}`, {
      repairStatus: "fixed",
      updatedAt: 130,
      summary: "Synchronized from terminal repair queue state (fixed).",
    });

    expect(reconcileRepositoryReviewQueueLedgerClosures(queue, ledger, 300)).toBe(1);
    expect(queue.list({ all: true })).toEqual([
      expect.objectContaining({
        id: created.id,
        status: "completed",
        lastError: "reconciled from daily task ledger repairStatus=fixed",
      }),
    ]);
    expect(queue.listReady(300)).toEqual([]);
  });

  it("closes retryable repository review queue items from completed recovery evidence", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-pr-review-service-"));
    const queue = new RepositoryReviewQueue();
    const ledger = new DailyTaskLedger();
    const scheduledAt = 1787542800000;
    const created = queue.enqueue({
      repositoryId: "knowledge-engine-all-prs",
      scheduledAt,
      priority: 1000,
      now: 100,
    });

    expect(queue.lease(created.id, "worker", 100, 100)).not.toBeNull();
    expect(
      queue.fail(
        created.id,
        "worker",
        110,
        "repository review supervisor result: dispatch-failed",
        200,
      ),
    ).toBe(true);
    ledger.expect({
      taskId: `loop:pr-review:knowledge-engine-all-prs:${scheduledAt}`,
      source: "loop-engineering",
      name: "knowledge-engine-all-prs repository-pull-request-review",
      scheduledAt,
    });
    ledger.fail(`loop:pr-review:knowledge-engine-all-prs:${scheduledAt}`, {
      endedAt: 120,
      error: "dispatch-failed",
    });
    ledger.markRepairStatus(`loop:pr-review:knowledge-engine-all-prs:${scheduledAt}`, {
      repairStatus: "completed",
      updatedAt: 130,
      summary: "Recovery completed by active delegated run.",
    });

    expect(reconcileRepositoryReviewQueueLedgerClosures(queue, ledger, 300)).toBe(1);
    expect(queue.list({ all: true })).toEqual([
      expect.objectContaining({
        id: created.id,
        status: "completed",
        lastError: "reconciled from daily task ledger repairStatus=completed",
      }),
    ]);
    expect(queue.listReady(300)).toEqual([]);
  });

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

  it("routes a prose-only manual result through recovery and keeps the occurrence retryable", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-pr-review-service-"));
    const root = mkdtempSync(join(tmpdir(), "tcb-pr-review-repo-"));
    const configFile = join(root, "loop.yml");
    writeFileSync(
      configFile,
      `
projects: []
prReview:
  repositories:
    - id: fluent-frame-all-prs
      name: Fluent Frame PRs
      path: ${root}
      repo: OctopusGarage/fluent-frame
      githubAccount: example-owner
      agent: codex
      schedule: "* * * * *"
      switchBack: dev
      worktreeIsolation: source
      runner:
        kind: agent-supervised
`,
    );
    const recover = vi.fn(() => ({
      disposition: "retry" as const,
      openPullRequests: 1,
      repaired: 1,
    }));

    const result = await runLoopServiceTickAsync({
      configFile,
      now: Date.parse("2026-08-12T05:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
      runSupervisorTask: async ({ prompt }) => {
        const marker = prompt.match(/\[LOOP_SUPERVISOR_DONE:[^\]]+\]/)?.[0];
        if (marker === undefined) throw new Error("missing final marker");
        return {
          status: 0,
          stdout: `${marker}${JSON.stringify({
            status: "blocked",
            projectId: "fluent-frame-all-prs",
            actionsTaken: ["workflow action_required; configured actor has admin permission"],
            delegatedTasks: [],
            finalVerification: "unknown",
            commits: [],
            followUps: ["retry after system repair"],
            pullRequestDecisions: [
              {
                number: 22,
                repository: "OctopusGarage/fluent-frame",
                outcome: "manual-review",
                evidence: ["workflow action_required; configured actor has admin permission"],
                nextStep: "retry after system repair",
              },
            ],
          })}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
      repositoryReviewOnly: true,
      repositoryPullRequestRecovery: { recover },
    });

    expect(result).toMatchObject({ ran: 1, failed: 1 });
    expect(recover).toHaveBeenCalledOnce();
    expect(new RepositoryReviewQueue().list({ all: true })[0]).toMatchObject({
      status: "retry-wait",
      lastError: "repository review has retryable or incomplete decisions",
    });
  });
});
