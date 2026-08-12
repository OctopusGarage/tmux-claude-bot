import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryPullRequestRecoveryStore } from "../../src/core/loop/repository-pr-recovery-store.js";

describe("repository PR recovery evidence store", () => {
  let previousStateDir: string | undefined;

  beforeEach(() => {
    previousStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-pr-recovery-"));
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = previousStateDir;
  });

  it("persists sanitized intent before its outcome", () => {
    const store = new RepositoryPullRequestRecoveryStore();
    const intent = store.begin({
      repository: "OctopusGarage/fluent-frame",
      number: 22,
      headSha: "abc123",
      action: "rerun-workflow",
      runId: 101,
      now: 1000,
    });
    expect(
      store.lookup({
        repository: "OctopusGarage/fluent-frame",
        number: 22,
        headSha: "abc123",
        action: "rerun-workflow",
        runId: 101,
      }),
    ).toBe("intent");
    store.finish(intent.id, { status: "succeeded", reason: "workflow rerun accepted", now: 1001 });
    expect(
      store.lookup({
        repository: "OctopusGarage/fluent-frame",
        number: 22,
        headSha: "abc123",
        action: "rerun-workflow",
        runId: 101,
      }),
    ).toBe("succeeded");

    expect(new RepositoryPullRequestRecoveryStore().list()).toEqual([
      expect.objectContaining({
        id: intent.id,
        repository: "OctopusGarage/fluent-frame",
        number: 22,
        headSha: "abc123",
        action: "rerun-workflow",
        status: "succeeded",
        reason: "workflow rerun accepted",
      }),
    ]);
  });

  it("redacts credentials and absolute home paths from outcome evidence", () => {
    const store = new RepositoryPullRequestRecoveryStore();
    const intent = store.begin({
      repository: "OctopusGarage/fluent-frame",
      number: 22,
      headSha: "abc123",
      action: "approve-workflow",
      runId: 101,
      now: 1000,
    });
    store.finish(intent.id, {
      status: "failed",
      reason: "token=secret at /Users/example/private/file",
      now: 1001,
    });

    expect(store.list()[0]?.reason).toBe("token=<redacted> at ~/private/file");
  });
});
