import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopGitInvocation, LoopRunCommandResult } from "../../src/core/loop/run.js";

const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../src/shared/utils/logger.js", () => ({
  createLogger: () => log,
  logger: log,
}));

const originalStateDir = process.env.TCB_STATE_DIR;
let stateDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-worktree-logging-"));
  process.env.TCB_STATE_DIR = stateDir;
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("loop execution worktree cleanup logging", () => {
  it("keeps already-reconciled missing worktree cleanup out of info logs", async () => {
    const { cleanupLoopExecutionWorktree } = await import(
      "../../src/core/loop/execution-worktree.js"
    );
    const sourceWorktree = join(stateDir, "source");
    const worktree = join(stateDir, "loop-worktrees", "hub", "completed-run");
    const branch = "loop/hub/architecture/completed-run";
    mkdirSync(sourceWorktree, { recursive: true });

    const runGit = (invocation: LoopGitInvocation): LoopRunCommandResult => {
      if (invocation.args.join(" ") === "rev-parse --show-toplevel") {
        return { status: 0, stdout: `${sourceWorktree}\n`, stderr: "" };
      }
      if (invocation.args.join(" ") === "worktree list --porcelain") {
        return {
          status: 0,
          stdout: `worktree ${sourceWorktree}\nbranch refs/heads/dev\n`,
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    };

    expect(
      cleanupLoopExecutionWorktree({ worktree, sourceWorktree, expectedBranch: branch, runGit }),
    ).toBe(true);

    expect(log.info).not.toHaveBeenCalledWith(
      "loop missing worktree registration is already reconciled",
      expect.anything(),
    );
    expect(log.debug).toHaveBeenCalledWith(
      "loop missing worktree registration is already reconciled",
      expect.anything(),
    );
  });
});
