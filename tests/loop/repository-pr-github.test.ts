import { describe, expect, it } from "vitest";
import {
  createRepositoryPullRequestGitHub,
  type RepositoryPullRequestGitHubRun,
} from "../../src/core/loop/repository-pr-github.js";

function fakeRun(responses: Record<string, unknown>): {
  run: RepositoryPullRequestGitHubRun;
  commands: string[];
} {
  const commands: string[] = [];
  return {
    commands,
    run: (command) => {
      commands.push(command);
      const entry = Object.entries(responses).find(([needle]) => command.includes(needle));
      return entry === undefined
        ? { status: 1, stdout: "", stderr: "unexpected command" }
        : { status: 0, stdout: JSON.stringify(entry[1]), stderr: "" };
    },
  };
}

describe("repository PR GitHub adapter", () => {
  it("observes one exact PR head through the configured account", () => {
    const fake = fakeRun({
      "/pulls/22": {
        number: 22,
        state: "open",
        draft: false,
        mergeable: false,
        mergeable_state: "dirty",
        head: { sha: "abc123", repo: { full_name: "OctopusGarage/fluent-frame" } },
        base: { repo: { full_name: "OctopusGarage/fluent-frame" } },
      },
      "/collaborators/example-owner/permission": { permission: "admin" },
      "actions/runs": {
        workflow_runs: [
          { id: 55, head_sha: "old", status: "completed", conclusion: "action_required" },
          { id: 56, head_sha: "abc123", status: "completed", conclusion: "action_required" },
        ],
      },
      "actions/permissions/fork-pr-workflows-private-repos": {
        run_workflows_from_fork_pull_requests: false,
        send_write_tokens_to_workflows: false,
        send_secrets_and_variables: false,
        require_approval_for_fork_pr_workflows: false,
      },
      "api repos/OctopusGarage/fluent-frame ": { private: true },
    });
    const github = createRepositoryPullRequestGitHub({ run: fake.run });

    expect(
      github.observe({
        repository: "OctopusGarage/fluent-frame",
        number: 22,
        account: "example-owner",
      }),
    ).toMatchObject({
      repository: "OctopusGarage/fluent-frame",
      number: 22,
      headSha: "abc123",
      repositoryPrivate: true,
      actorPermission: "admin",
      workflowRuns: [{ id: 56, headSha: "abc123", conclusion: "action_required" }],
    });
    expect(fake.commands).toHaveLength(5);
    expect(fake.commands).toContainEqual(
      expect.stringContaining("actions/permissions/fork-pr-workflows-private-repos"),
    );
    expect(fake.commands).toContainEqual(
      expect.stringContaining("actions/runs?head_sha=abc123&per_page=100"),
    );
    expect(fake.commands).not.toContainEqual(expect.stringMatching(/permissions\/fork-pr(?:\s|$)/));
    expect(
      fake.commands.every((command) => command.includes("gh auth token --user 'example-owner'")),
    ).toBe(true);
  });

  it("writes only the safe private-fork policy and verifies it", () => {
    const commands: string[] = [];
    const run: RepositoryPullRequestGitHubRun = (command) => {
      commands.push(command);
      if (command.includes("--method PUT")) return { status: 0, stdout: "{}", stderr: "" };
      return {
        status: 0,
        stdout: JSON.stringify({
          run_workflows_from_fork_pull_requests: true,
          send_write_tokens_to_workflows: false,
          send_secrets_and_variables: false,
          require_approval_for_fork_pr_workflows: false,
        }),
        stderr: "",
      };
    };
    const github = createRepositoryPullRequestGitHub({ run });

    expect(
      github.execute(
        { repository: "OctopusGarage/fluent-frame", number: 22, headSha: "abc123" },
        {
          kind: "configure-private-fork-workflows",
          policy: {
            runWorkflowsFromForkPullRequests: true,
            sendWriteTokensToWorkflows: false,
            sendSecretsAndVariables: false,
            requireApprovalForForkPrWorkflows: false,
          },
        },
        "example-owner",
      ),
    ).toEqual({ ok: true });
    expect(commands[0]).toContain("run_workflows_from_fork_pull_requests=true");
    expect(commands[0]).toContain("actions/permissions/fork-pr-workflows-private-repos");
    expect(commands[0]).toContain("send_write_tokens_to_workflows=false");
    expect(commands[0]).toContain("send_secrets_and_variables=false");
  });

  it("refuses unsafe policy input before running a command", () => {
    const commands: string[] = [];
    const github = createRepositoryPullRequestGitHub({
      run: (command) => {
        commands.push(command);
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });

    expect(
      github.execute(
        { repository: "OctopusGarage/fluent-frame", number: 22, headSha: "abc123" },
        {
          kind: "configure-private-fork-workflows",
          policy: {
            runWorkflowsFromForkPullRequests: true,
            sendWriteTokensToWorkflows: true,
            sendSecretsAndVariables: false,
            requireApprovalForForkPrWorkflows: false,
          },
        },
        "example-owner",
      ),
    ).toEqual({ ok: false, reason: "unsafe private-fork workflow policy refused" });
    expect(commands).toEqual([]);
  });

  it("marks a reviewed draft pull request ready through the configured account", () => {
    const commands: string[] = [];
    const github = createRepositoryPullRequestGitHub({
      run: (command) => {
        commands.push(command);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(
      github.execute(
        { repository: "OctopusGarage/fluent-frame", number: 22, headSha: "abc123" },
        { kind: "mark-ready" },
        "example-owner",
      ),
    ).toEqual({ ok: true });
    expect(commands).toEqual([expect.stringContaining("gh auth token --user 'example-owner'")]);
    expect(commands[0]).toContain("pr ready 22 --repo OctopusGarage/fluent-frame");
  });
});
