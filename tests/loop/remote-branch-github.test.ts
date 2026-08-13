import { describe, expect, it } from "vitest";
import {
  createLoopRemoteBranchGitHub,
  type LoopRemoteBranchGitHubRun,
} from "../../src/core/loop/remote-branch-github.js";

const target = {
  repository: "OctopusGarage/tmux-claude-bot",
  projectId: "tmux-claude-bot",
  account: "example-owner",
  baseBranches: ["main", "dev"],
};

describe("Loop remote branch GitHub adapter", () => {
  it("discovers only a bounded configured Loop prefix through the configured account", async () => {
    const commands: string[] = [];
    const run: LoopRemoteBranchGitHubRun = (command) => {
      commands.push(command);
      if (command.includes("/git/matching-refs/heads/loop%2Ftmux-claude-bot%2F?per_page=1")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { ref: "refs/heads/loop/tmux-claude-bot/a", object: { sha: "abc123" } },
            { ref: "refs/heads/loop/tmux-claude-bot/b", object: { sha: "def456" } },
          ]),
          stderr: "",
        };
      }
      return { status: 0, stdout: JSON.stringify({ default_branch: "main" }), stderr: "" };
    };
    const github = createLoopRemoteBranchGitHub({ run });

    await expect(github.discover(target, 1)).resolves.toEqual({
      defaultBranch: "main",
      branches: [{ branch: "loop/tmux-claude-bot/a" }],
    });
    expect(commands).toHaveLength(2);
    expect(
      commands.every((command) => command.includes("gh auth token --user 'example-owner'")),
    ).toBe(true);
  });

  it("observes exact ref, protection, and associated pull requests", async () => {
    const branch = "loop/tmux-claude-bot/architecture/100-worker";
    const run: LoopRemoteBranchGitHubRun = (command) => {
      if (command.includes("/git/ref/heads/")) {
        return { status: 0, stdout: JSON.stringify({ object: { sha: "abc123" } }), stderr: "" };
      }
      if (command.includes("/branches/")) {
        return { status: 0, stdout: JSON.stringify({ protected: false }), stderr: "" };
      }
      if (command.includes("/pulls?")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              number: 22,
              state: "closed",
              merged_at: "2026-08-12T00:00:00Z",
              head: {
                ref: branch,
                sha: "abc123",
                repo: { full_name: "OctopusGarage/tmux-claude-bot" },
              },
              base: { ref: "dev" },
            },
          ]),
          stderr: "",
        };
      }
      return { status: 0, stdout: JSON.stringify({ default_branch: "main" }), stderr: "" };
    };
    const github = createLoopRemoteBranchGitHub({ run });

    await expect(github.observe(target, branch)).resolves.toEqual({
      repository: target.repository,
      branch,
      sha: "abc123",
      protected: false,
      defaultBranch: "main",
      pullRequests: [
        {
          number: 22,
          state: "merged",
          headBranch: branch,
          headSha: "abc123",
          baseBranch: "dev",
        },
      ],
    });
  });

  it("derives an allowlisted external close reason only from an authorized post-close comment", async () => {
    const branch = "loop/tmux-claude-bot/harness-auto/100-worker";
    const run: LoopRemoteBranchGitHubRun = (command) => {
      if (command.includes("/git/ref/heads/")) {
        return { status: 0, stdout: JSON.stringify({ object: { sha: "abc123" } }), stderr: "" };
      }
      if (command.includes("/branches/")) {
        return { status: 0, stdout: JSON.stringify({ protected: false }), stderr: "" };
      }
      if (command.includes("/pulls?")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              number: 22,
              state: "closed",
              merged_at: null,
              closed_at: "2026-08-07T14:16:23Z",
              head: {
                ref: branch,
                sha: "abc123",
                repo: { full_name: target.repository },
              },
              base: { ref: "dev" },
            },
          ]),
          stderr: "",
        };
      }
      if (command.includes("/issues/22/comments?")) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              body: "obsolete — superseded before the PR was closed",
              created_at: "2026-08-07T14:16:22Z",
              author_association: "MEMBER",
            },
            {
              body: "obsolete — current dev contains the same or newer fix",
              created_at: "2026-08-07T14:16:23Z",
              author_association: "MEMBER",
            },
            {
              body: "invalid — this later comment is not repository-authorized",
              created_at: "2026-08-07T14:16:24Z",
              author_association: "CONTRIBUTOR",
            },
          ]),
          stderr: "",
        };
      }
      return { status: 0, stdout: JSON.stringify({ default_branch: "main" }), stderr: "" };
    };
    const github = createLoopRemoteBranchGitHub({ run });

    await expect(github.observe(target, branch)).resolves.toEqual({
      repository: target.repository,
      branch,
      sha: "abc123",
      protected: false,
      defaultBranch: "main",
      pullRequests: [
        {
          number: 22,
          state: "closed",
          headBranch: branch,
          headSha: "abc123",
          baseBranch: "dev",
          closedAt: "2026-08-07T14:16:23Z",
          externalCloseReason: "obsolete",
        },
      ],
    });
  });

  it("deletes only the exact encoded ref and treats absence as idempotent", async () => {
    const commands: string[] = [];
    const run: LoopRemoteBranchGitHubRun = (command) => {
      commands.push(command);
      if (command.includes("missing")) {
        return { status: 1, stdout: "", stderr: "HTTP 422: Reference does not exist" };
      }
      return command.includes("--method DELETE")
        ? { status: 0, stdout: "", stderr: "" }
        : { status: 0, stdout: JSON.stringify({ object: { sha: "abc123" } }), stderr: "" };
    };
    const github = createLoopRemoteBranchGitHub({ run });

    await expect(
      github.delete(target, "loop/tmux-claude-bot/architecture/100-worker", "abc123"),
    ).resolves.toEqual({ ok: true, alreadyAbsent: false });
    await expect(github.delete(target, "loop/tmux-claude-bot/missing", "abc123")).resolves.toEqual({
      ok: true,
      alreadyAbsent: true,
    });
    expect(commands[1]).toContain("--method DELETE");
    expect(commands[1]).toContain(
      "git/refs/heads/loop%2Ftmux-claude-bot%2Farchitecture%2F100-worker",
    );
  });

  it("refuses deletion when the exact ref no longer has the expected SHA", async () => {
    const commands: string[] = [];
    const github = createLoopRemoteBranchGitHub({
      run: (command) => {
        commands.push(command);
        return {
          status: 0,
          stdout: JSON.stringify({ object: { sha: "def456" } }),
          stderr: "",
        };
      },
    });

    await expect(
      github.delete(target, "loop/tmux-claude-bot/architecture/100-worker", "abc123"),
    ).resolves.toEqual({
      ok: false,
      alreadyAbsent: false,
      reason: "GitHub branch SHA changed before deletion",
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain("--method DELETE");
  });

  it("fails closed on invalid repository, branch, and SHA inputs", async () => {
    const github = createLoopRemoteBranchGitHub({
      run: () => ({ status: 0, stdout: "{}", stderr: "" }),
    });
    await expect(github.observe({ ...target, repository: "bad" }, "loop/x/y")).rejects.toThrow(
      "invalid GitHub repository identifier",
    );
    await expect(github.delete(target, "../main", "abc123")).resolves.toEqual({
      ok: false,
      alreadyAbsent: false,
      reason: "invalid GitHub branch name",
    });
    await expect(github.delete(target, "loop/tmux-claude-bot/a", "not-a-sha")).resolves.toEqual({
      ok: false,
      alreadyAbsent: false,
      reason: "invalid GitHub commit SHA",
    });
  });
});
