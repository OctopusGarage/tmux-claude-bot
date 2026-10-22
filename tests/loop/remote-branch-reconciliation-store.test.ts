import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoopRemoteBranchReconciliationStore } from "../../src/core/loop/remote-branch-reconciliation-store.js";

describe("Loop remote branch reconciliation evidence store", () => {
  let previousStateDir: string | undefined;

  beforeEach(() => {
    previousStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-branch-reconciliation-"));
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = previousStateDir;
  });

  it("persists an exact deletion intent and its sanitized outcome", () => {
    const store = new LoopRemoteBranchReconciliationStore();
    const intent = store.begin({
      repository: "OctopusGarage/tmux-claude-bot",
      branch: "loop/tmux-claude-bot/architecture/100-worker",
      sha: "abc123",
      pullRequestNumber: 22,
      reason: "merged-pull-request",
      now: 1000,
    });
    expect(
      store.lookup({
        repository: "OctopusGarage/tmux-claude-bot",
        branch: "loop/tmux-claude-bot/architecture/100-worker",
        sha: "abc123",
        pullRequestNumber: 22,
      }),
    ).toBe("intent");

    store.finish(intent.id, {
      status: "failed",
      reason: "token=secret at /Users/example/private/file",
      now: 1001,
    });

    expect(new LoopRemoteBranchReconciliationStore().list()).toEqual([
      expect.objectContaining({
        id: intent.id,
        status: "failed",
        reason: "token=<redacted> at ~/private/file",
      }),
    ]);
  });
});
