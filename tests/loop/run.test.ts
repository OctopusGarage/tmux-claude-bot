import { describe, expect, it } from "vitest";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";
import {
  type LoopAgentTaskInvocation,
  type LoopRunCommandInvocation,
  runLoopProject,
  runLoopProjectAsync,
} from "../../src/core/loop/run.js";

const configText = `
projects:
  - id: hub
    name: Hub
    path: /repo/hub
    agent: codex
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
    eval:
      command: npm run loop-eval
      minScore: 95
`;

const agentEvalConfigText = `
projects:
  - id: hub
    name: Hub
    path: /repo/hub
    agent: codex
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
    eval:
      agent: true
      minScore: 95
`;

const executableConfigText = `
projects:
  - id: hub
    name: Hub
    path: /repo/hub
    agent: codex
    goal: Improve core module clarity in small verified slices.
    maxRounds: 2
    targetScore: 90
    execution:
      agent: true
    assessment:
      command: npm run assess
    commit:
      enabled: true
      perRound: true
      branch: loop/hub
    allowedActions: [tests, docs, small-refactor]
    blockedActions: [direct-model-api, dependency-upgrade, broad-rewrite]
`;

const pullRequestConfigText = `
projects:
  - id: hub
    name: Hub
    path: /repo/hub
    agent: codex
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    execution:
      agent: true
    assessment:
      command: npm run assess
    eval:
      agent: true
      minScore: 90
    commit:
      enabled: true
      perRound: true
      branch: loop/hub
    pullRequest:
      enabled: true
      base: main
      switchBack: main
    allowedActions: [tests, docs, small-refactor]
    blockedActions: [direct-model-api, dependency-upgrade, broad-rewrite]
`;

const closedLoopConfigText = `
projects:
  - id: hub
    name: Hub
    path: /repo/hub
    agent: codex
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    execution:
      agent: true
    preflight:
      commands:
        - test -x .venv/bin/pytest
      repair:
        agent: true
        prompt: Repair the local project environment using its own setup docs.
    recovery:
      agent: true
      dirtyWorktree: true
      maxAttempts: 1
    assessment:
      command: npm run assess
    commit:
      enabled: true
      perRound: true
      branch: loop/hub
    allowedActions: [tests, docs, small-refactor]
    blockedActions: [direct-model-api, dependency-upgrade, broad-rewrite]
`;

describe("runLoopProject", () => {
  it("runs assessment and command eval in the project directory", () => {
    const config = parseLoopConfigYaml(configText);
    const invocations: LoopRunCommandInvocation[] = [];

    const summary = runLoopProject({
      config,
      projectId: "hub",
      runCommand: (invocation) => {
        invocations.push(invocation);
        return { status: 0, stdout: `${invocation.kind}-ok`, stderr: "" };
      },
    });

    expect(summary).toMatchObject({
      phase: "command-run",
      projectId: "hub",
      status: "passed",
      executed: 2,
      committed: false,
    });
    expect(
      invocations.map((invocation) => [invocation.kind, invocation.command, invocation.cwd]),
    ).toEqual([
      ["assessment", "npm run assess", "/repo/hub"],
      ["eval", "npm run loop-eval", "/repo/hub"],
    ]);
    expect(invocations[0]?.env).toMatchObject({
      LOOP_PROJECT_ID: "hub",
      LOOP_PROJECT_NAME: "Hub",
      LOOP_PROJECT_AGENT: "codex",
      LOOP_PROJECT_TARGET_SCORE: "90",
    });
    expect(
      summary.commands.map((command) => [command.kind, command.status, command.stdout]),
    ).toEqual([
      ["assessment", 0, "assessment-ok"],
      ["eval", 0, "eval-ok"],
    ]);
  });

  it("stops before eval when assessment fails", () => {
    const config = parseLoopConfigYaml(configText);
    const invocations: LoopRunCommandInvocation[] = [];

    const summary = runLoopProject({
      config,
      projectId: "hub",
      runCommand: (invocation) => {
        invocations.push(invocation);
        return { status: invocation.kind === "assessment" ? 2 : 0, stdout: "", stderr: "failed" };
      },
    });

    expect(summary.status).toBe("failed");
    expect(summary.executed).toBe(1);
    expect(invocations.map((invocation) => invocation.kind)).toEqual(["assessment"]);
    expect(summary.commands[0]).toMatchObject({
      kind: "assessment",
      status: 2,
      stderr: "failed",
    });
  });

  it("reports unknown project ids without running commands", () => {
    const config = parseLoopConfigYaml(configText);
    const invocations: LoopRunCommandInvocation[] = [];

    expect(() =>
      runLoopProject({
        config,
        projectId: "missing",
        runCommand: (invocation) => {
          invocations.push(invocation);
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    ).toThrow(/unknown loop project "missing"/i);
    expect(invocations).toEqual([]);
  });

  it("rejects non-command assessment boundaries at runtime", () => {
    const config = parseLoopConfigYaml(configText);
    const project = config.projects[0];
    if (project === undefined) throw new Error("missing fixture project");
    project.assessment = { agent: true };

    expect(() =>
      runLoopProject({
        config,
        projectId: "hub",
        runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).toThrow(/requires assessment.command/i);
  });

  it("runs agent-backed eval through an injected active-agent adapter", () => {
    const config = parseLoopConfigYaml(agentEvalConfigText);
    const agentPrompts: string[] = [];

    const summary = runLoopProject({
      config,
      projectId: "hub",
      runCommand: () => ({ status: 0, stdout: "assessment-ok", stderr: "" }),
      runAgentEval: (invocation) => {
        agentPrompts.push(invocation.prompt);
        return {
          status: 0,
          stdout: JSON.stringify({
            passed: true,
            score: 96,
            findings: [],
            suggestedBotImprovements: ["Expose loop run reports in the CLI."],
          }),
          stderr: "",
        };
      },
    });

    expect(agentPrompts[0]).toContain("Project: Hub");
    expect(summary.status).toBe("passed");
    expect(summary.evalResult).toMatchObject({ passed: true, score: 96 });
    expect(summary.suggestedBotImprovements).toEqual(["Expose loop run reports in the CLI."]);
    expect(summary.commands.map((command) => command.kind)).toEqual(["assessment", "eval"]);
  });

  it("plans a safe finding, runs it through an agent adapter, verifies it, and commits", () => {
    const config = parseLoopConfigYaml(executableConfigText);
    const agentPrompts: string[] = [];
    const agentTasks: LoopAgentTaskInvocation[] = [];
    const commandInvocations: LoopRunCommandInvocation[] = [];
    const gitCommands: string[][] = [];

    const summary = runLoopProject({
      config,
      projectId: "hub",
      runCommand: (invocation) => {
        commandInvocations.push(invocation);
        if (invocation.kind === "assessment") {
          return {
            status: 0,
            stdout: JSON.stringify({
              score: 72,
              findings: [
                {
                  id: "f1",
                  title: "Extract parser tests",
                  action: "tests",
                  confidence: "high",
                  autofixSafety: "safe",
                  affectedFiles: ["tests/parser.test.ts"],
                  prompt: "Add focused parser regression tests.",
                  verificationCommands: ["npm test -- tests/parser.test.ts"],
                },
                {
                  id: "unsafe",
                  title: "Rewrite everything",
                  action: "broad-rewrite",
                  confidence: "high",
                  autofixSafety: "safe",
                  affectedFiles: ["src/index.ts"],
                  verificationCommands: ["npm test"],
                },
              ],
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "verified", stderr: "" };
      },
      runAgentTask: (invocation) => {
        agentTasks.push(invocation);
        agentPrompts.push(invocation.prompt);
        return { status: 0, stdout: "agent changed files", stderr: "" };
      },
      runGit: (invocation) => {
        gitCommands.push(invocation.args);
        if (invocation.args[0] === "diff") {
          return { status: 1, stdout: "", stderr: "" };
        }
        return {
          status: 0,
          stdout: invocation.args.includes("rev-parse") ? "abc123\n" : "",
          stderr: "",
        };
      },
    });

    expect(summary.status).toBe("passed");
    expect(summary.rounds).toEqual([
      expect.objectContaining({
        findingId: "unsafe",
        title: "Rewrite everything",
        status: "skipped",
        reason: "blocked action: broad-rewrite",
      }),
      expect.objectContaining({
        findingId: "f1",
        title: "Extract parser tests",
        status: "committed",
        commitSha: "abc123",
      }),
    ]);
    expect(agentPrompts[0]).toContain("Add focused parser regression tests.");
    expect(agentTasks[0]?.contextReset).toBe("compact");
    expect(agentPrompts[0]).toContain(
      "If a project verification or commit hook fails because of an existing dependency advisory",
    );
    expect(commandInvocations.map((invocation) => invocation.kind)).toEqual([
      "assessment",
      "verification",
    ]);
    expect(summary.commands.map((command) => command.kind)).toEqual([
      "assessment",
      "commit",
      "agent",
      "verification",
      "commit",
      "commit",
      "commit",
      "commit",
      "commit",
    ]);
    expect(gitCommands).toEqual([
      ["switch", "loop/hub"],
      ["add", "--", "tests/parser.test.ts"],
      ["diff", "--cached", "--quiet"],
      ["commit", "-m", "loop(hub): Extract parser tests"],
      ["status", "--porcelain"],
      ["rev-parse", "HEAD"],
    ]);
  });

  it("skips architecture optimization when the assessment score already reaches the target", () => {
    const config = parseLoopConfigYaml(
      executableConfigText.replace("targetScore: 90", "targetScore: 95"),
    );
    const commandInvocations: LoopRunCommandInvocation[] = [];
    const gitCommands: string[][] = [];
    let agentTasks = 0;

    const summary = runLoopProject({
      config,
      projectId: "hub",
      runCommand: (invocation) => {
        commandInvocations.push(invocation);
        if (invocation.kind === "assessment") {
          return {
            status: 0,
            stdout: JSON.stringify({
              score: 95,
              findings: [
                {
                  id: "f1",
                  title: "Extract parser tests",
                  action: "tests",
                  confidence: "high",
                  autofixSafety: "safe",
                  affectedFiles: ["tests/parser.test.ts"],
                  prompt: "Add focused parser regression tests.",
                  verificationCommands: ["npm test -- tests/parser.test.ts"],
                },
              ],
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "should not run", stderr: "" };
      },
      runAgentTask: () => {
        agentTasks++;
        return { status: 0, stdout: "should not run", stderr: "" };
      },
      runGit: (invocation) => {
        gitCommands.push(invocation.args);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(summary).toMatchObject({
      status: "passed",
      committed: false,
      executed: 1,
    });
    expect(commandInvocations.map((invocation) => invocation.kind)).toEqual(["assessment"]);
    expect(agentTasks).toBe(0);
    expect(gitCommands).toEqual([]);
    expect(summary.rounds).toEqual([
      expect.objectContaining({
        findingId: "target-score-reached",
        status: "skipped",
        reason:
          "assessment score 95 is >= targetScore 95; skipping optimization to avoid over-optimization",
      }),
    ]);
  });

  it("pushes a committed loop branch, opens a PR with run details, and switches back to main", async () => {
    const config = parseLoopConfigYaml(pullRequestConfigText);
    const gitCommands: string[][] = [];
    const prCommands: string[] = [];
    const agentPrompts: string[] = [];

    const summary = await runLoopProjectAsync({
      config,
      projectId: "hub",
      runCommand: (invocation) => {
        if (invocation.kind === "assessment") {
          return {
            status: 0,
            stdout: JSON.stringify({
              score: 72,
              findings: [
                {
                  id: "f1",
                  title: "Extract parser tests",
                  action: "tests",
                  confidence: "high",
                  autofixSafety: "safe",
                  affectedFiles: ["tests/parser.test.ts"],
                  prompt: "Add focused parser regression tests.",
                  verificationCommands: ["npm test -- tests/parser.test.ts"],
                },
              ],
            }),
            stderr: "",
          };
        }
        if (invocation.kind === "eval") {
          return {
            status: 0,
            stdout: JSON.stringify({
              passed: true,
              score: 94,
              findings: [],
              suggestedBotImprovements: [],
            }),
            stderr: "",
          };
        }
        if (invocation.kind === "pr") {
          prCommands.push(invocation.command);
          return { status: 0, stdout: "https://github.test/repo/pull/1\n", stderr: "" };
        }
        return { status: 0, stdout: "verified", stderr: "" };
      },
      runAgentTask: async (invocation) => {
        agentPrompts.push(invocation.prompt);
        return { status: 0, stdout: "agent changed files", stderr: "" };
      },
      runAgentEval: async () => ({
        status: 0,
        stdout: JSON.stringify({
          passed: true,
          score: 94,
          findings: [],
          suggestedBotImprovements: [],
        }),
        stderr: "",
      }),
      runGit: (invocation) => {
        gitCommands.push(invocation.args);
        if (invocation.args.join(" ") === "diff --cached --quiet") {
          return { status: 1, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "rev-parse HEAD") {
          return { status: 0, stdout: "abc123\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(summary.status).toBe("passed");
    expect(summary.rounds).toEqual([
      expect.objectContaining({ findingId: "f1", status: "committed", commitSha: "abc123" }),
    ]);
    expect(agentPrompts[0]).toContain("Do not open browser windows");
    expect(gitCommands).toEqual([
      ["switch", "loop/hub"],
      ["add", "--", "tests/parser.test.ts"],
      ["diff", "--cached", "--quiet"],
      ["commit", "-m", "loop(hub): Extract parser tests"],
      ["status", "--porcelain"],
      ["rev-parse", "HEAD"],
      ["status", "--porcelain"],
      ["log", "-1", "--stat", "--oneline"],
      ["push", "-u", "origin", "loop/hub"],
      ["switch", "main"],
    ]);
    expect(prCommands).toHaveLength(1);
    expect(prCommands[0]).toContain("gh pr create");
    expect(prCommands[0]).toContain("--base 'main'");
    expect(prCommands[0]).toContain("--head 'loop/hub'");
    expect(prCommands[0]).toContain("Extract parser tests");
    expect(summary.commands.map((command) => command.kind)).toContain("pr");
  });

  it("opens a PR after creating a missing loop branch during commit setup", async () => {
    const config = parseLoopConfigYaml(pullRequestConfigText);
    const gitCommands: string[][] = [];
    const prCommands: string[] = [];

    const summary = await runLoopProjectAsync({
      config,
      projectId: "hub",
      runCommand: (invocation) => {
        if (invocation.kind === "assessment") {
          return {
            status: 0,
            stdout: JSON.stringify({
              findings: [
                {
                  id: "f1",
                  title: "Extract parser tests",
                  action: "tests",
                  confidence: "high",
                  autofixSafety: "safe",
                  affectedFiles: ["tests/parser.test.ts"],
                  prompt: "Add focused parser regression tests.",
                  verificationCommands: ["npm test -- tests/parser.test.ts"],
                },
              ],
            }),
            stderr: "",
          };
        }
        if (invocation.kind === "pr") {
          prCommands.push(invocation.command);
          return { status: 0, stdout: "https://github.test/repo/pull/2\n", stderr: "" };
        }
        return { status: 0, stdout: "ok", stderr: "" };
      },
      runAgentTask: async () => ({ status: 0, stdout: "agent changed files", stderr: "" }),
      runAgentEval: async () => ({
        status: 0,
        stdout: JSON.stringify({
          passed: true,
          score: 94,
          findings: [],
          suggestedBotImprovements: [],
        }),
        stderr: "",
      }),
      runGit: (invocation) => {
        gitCommands.push(invocation.args);
        if (invocation.args.join(" ") === "switch loop/hub") {
          return { status: 128, stdout: "", stderr: "fatal: invalid reference: loop/hub" };
        }
        if (invocation.args.join(" ") === "diff --cached --quiet") {
          return { status: 1, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "status --porcelain") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "rev-parse HEAD") {
          return { status: 0, stdout: "abc123\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(summary.status).toBe("passed");
    expect(prCommands).toHaveLength(1);
    expect(gitCommands).toEqual([
      ["switch", "loop/hub"],
      ["switch", "-c", "loop/hub"],
      ["add", "--", "tests/parser.test.ts"],
      ["diff", "--cached", "--quiet"],
      ["commit", "-m", "loop(hub): Extract parser tests"],
      ["status", "--porcelain"],
      ["rev-parse", "HEAD"],
      ["status", "--porcelain"],
      ["log", "-1", "--stat", "--oneline"],
      ["push", "-u", "origin", "loop/hub"],
      ["switch", "main"],
    ]);
    expect(summary.commands).toContainEqual(
      expect.objectContaining({
        kind: "commit",
        command: "git switch loop/hub; git switch -c loop/hub",
        status: 0,
        stderr: expect.stringContaining("fatal: invalid reference: loop/hub"),
      }),
    );
  });

  it("publishes a recovered dirty-worktree commit as a PR and switches back", async () => {
    const config = parseLoopConfigYaml(
      pullRequestConfigText.replace(
        "pullRequest:",
        `recovery:
      agent: true
      dirtyWorktree: true
      maxAttempts: 1
    pullRequest:`,
      ),
    );
    const gitCommands: string[][] = [];
    const prCommands: string[] = [];
    const evalPrompts: string[] = [];
    let statusChecks = 0;

    const summary = await runLoopProjectAsync({
      config,
      projectId: "hub",
      runCommand: (invocation) => {
        if (invocation.kind === "pr") {
          prCommands.push(invocation.command);
          return { status: 0, stdout: "https://github.test/repo/pull/3\n", stderr: "" };
        }
        return { status: 0, stdout: "ok", stderr: "" };
      },
      runAgentTask: async () => ({
        status: 0,
        stdout: "recovered and committed existing dirty slice",
        stderr: "",
      }),
      runAgentEval: async (invocation) => {
        evalPrompts.push(invocation.prompt);
        return {
          status: 0,
          stdout: JSON.stringify({
            passed: true,
            score: 95,
            findings: ["dirty recovery was verified before publishing"],
            suggestedBotImprovements: [],
          }),
          stderr: "",
        };
      },
      runGit: (invocation) => {
        gitCommands.push(invocation.args);
        if (invocation.args.join(" ") === "status --porcelain") {
          statusChecks++;
          return {
            status: 0,
            stdout: statusChecks === 1 ? " M src/recovered.ts\n" : "",
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(summary.status).toBe("passed");
    expect(summary.rounds).toEqual([
      expect.objectContaining({
        findingId: "dirty-worktree-recovery",
        status: "committed",
      }),
    ]);
    expect(evalPrompts).toHaveLength(1);
    expect(prCommands).toHaveLength(1);
    expect(prCommands[0]).toContain("gh pr create");
    expect(prCommands[0]).toContain("Recover dirty worktree");
    expect(gitCommands).toEqual([
      ["status", "--porcelain"],
      ["status", "--porcelain"],
      ["status", "--porcelain"],
      ["log", "-1", "--stat", "--oneline"],
      ["push", "-u", "origin", "loop/hub"],
      ["switch", "main"],
    ]);
  });

  it("does not push or open a PR when the final pre-PR worktree review is dirty", async () => {
    const config = parseLoopConfigYaml(pullRequestConfigText);
    const gitCommands: string[][] = [];
    const prCommands: string[] = [];
    let postCommitStatusChecks = 0;

    const summary = await runLoopProjectAsync({
      config,
      projectId: "hub",
      runCommand: (invocation) => {
        if (invocation.kind === "assessment") {
          return {
            status: 0,
            stdout: JSON.stringify({
              findings: [
                {
                  id: "f1",
                  title: "Extract parser tests",
                  action: "tests",
                  confidence: "high",
                  autofixSafety: "safe",
                  affectedFiles: ["tests/parser.test.ts"],
                  prompt: "Add focused parser regression tests.",
                  verificationCommands: ["npm test -- tests/parser.test.ts"],
                },
              ],
              suggestedBotImprovements: [],
            }),
            stderr: "",
          };
        }
        if (invocation.kind === "pr") {
          prCommands.push(invocation.command);
        }
        return { status: 0, stdout: "ok", stderr: "" };
      },
      runAgentTask: async () => ({ status: 0, stdout: "agent changed files", stderr: "" }),
      runAgentEval: async () => ({
        status: 0,
        stdout: JSON.stringify({ passed: true, score: 94, findings: [] }),
        stderr: "",
      }),
      runGit: (invocation) => {
        gitCommands.push(invocation.args);
        if (invocation.args.join(" ") === "diff --cached --quiet") {
          return { status: 1, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "status --porcelain") {
          postCommitStatusChecks++;
          return {
            status: 0,
            stdout: postCommitStatusChecks >= 2 ? " M src/unreviewed.ts\n" : "",
            stderr: "",
          };
        }
        if (invocation.args.join(" ") === "rev-parse HEAD") {
          return { status: 0, stdout: "abc123\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(summary.status).toBe("failed");
    expect(prCommands).toEqual([]);
    expect(summary.commands).toContainEqual(
      expect.objectContaining({
        kind: "pr",
        command: "pull request skipped: final worktree review is dirty",
        status: 1,
        stderr: "M src/unreviewed.ts",
      }),
    );
    expect(gitCommands).not.toContainEqual(["push", "-u", "origin", "loop/hub"]);
    expect(gitCommands).not.toContainEqual(["switch", "main"]);
  });

  it("recovers a committed round when verified changes remain outside affected files", () => {
    const config = parseLoopConfigYaml(closedLoopConfigText);
    const gitCommands: string[][] = [];
    const agentPrompts: string[] = [];
    let statusChecks = 0;

    const summary = runLoopProject({
      config,
      projectId: "hub",
      runCommand: (invocation) => {
        if (invocation.command === "test -x .venv/bin/pytest") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.kind === "assessment") {
          return {
            status: 0,
            stdout: JSON.stringify({
              score: 72,
              findings: [
                {
                  id: "f1",
                  title: "Add architecture guard",
                  action: "small-refactor",
                  confidence: "high",
                  autofixSafety: "guarded",
                  affectedFiles: ["src"],
                  prompt: "Add a focused architecture guard.",
                  verificationCommands: ["npm test"],
                },
              ],
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "verified", stderr: "" };
      },
      runAgentTask: (invocation) => {
        agentPrompts.push(invocation.prompt);
        return { status: 0, stdout: "recovered and committed residual changes", stderr: "" };
      },
      runGit: (invocation) => {
        gitCommands.push(invocation.args);
        if (invocation.args.join(" ") === "diff --cached --quiet") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.args.join(" ") === "status --porcelain") {
          statusChecks++;
          return {
            status: 0,
            stdout: statusChecks === 2 ? " M .semgrep/datavibe-arch.yml\n" : "",
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(summary.status).toBe("passed");
    expect(summary.rounds).toEqual([
      expect.objectContaining({
        findingId: "f1",
        status: "committed",
      }),
    ]);
    expect(agentPrompts).toHaveLength(2);
    expect(agentPrompts[1]).toContain(".semgrep/datavibe-arch.yml");
    expect(gitCommands).toContainEqual(["status", "--porcelain"]);
  });

  it("async runner recovers verified residual changes instead of leaving the target worktree dirty", async () => {
    const config = parseLoopConfigYaml(closedLoopConfigText);
    const agentPrompts: string[] = [];
    let statusChecks = 0;

    const summary = await runLoopProjectAsync({
      config,
      projectId: "hub",
      runCommand: (invocation) => {
        if (invocation.command === "test -x .venv/bin/pytest") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.kind === "assessment") {
          return {
            status: 0,
            stdout: JSON.stringify({
              score: 72,
              findings: [
                {
                  id: "f1",
                  title: "Add architecture guard",
                  action: "small-refactor",
                  confidence: "high",
                  autofixSafety: "guarded",
                  affectedFiles: ["src"],
                  prompt: "Add a focused architecture guard.",
                  verificationCommands: ["npm test"],
                },
              ],
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "verified", stderr: "" };
      },
      runAgentTask: async (invocation) => {
        agentPrompts.push(invocation.prompt);
        return { status: 0, stdout: "agent handled task", stderr: "" };
      },
      runGit: (invocation) => {
        if (invocation.args.join(" ") === "status --porcelain") {
          statusChecks++;
          return {
            status: 0,
            stdout: statusChecks === 2 ? " M .semgrep/datavibe-arch.yml\n" : "",
            stderr: "",
          };
        }
        if (invocation.args.join(" ") === "diff --cached --quiet") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(summary.status).toBe("passed");
    expect(summary.rounds).toEqual([
      expect.objectContaining({
        findingId: "f1",
        status: "committed",
      }),
    ]);
    expect(agentPrompts).toHaveLength(2);
    expect(agentPrompts[1]).toContain("worktree still has verified changes");
    expect(agentPrompts[1]).toContain(
      "If the remaining blocker is a dependency audit or commit-hook dependency advisory",
    );
    expect(summary.commands.map((command) => command.command)).toContain(
      "agent-post-commit-recovery",
    );
  });

  it("async runner recovers when the commit hook fails but verified changes remain", async () => {
    const config = parseLoopConfigYaml(closedLoopConfigText);
    const agentPrompts: string[] = [];
    let statusChecks = 0;

    const summary = await runLoopProjectAsync({
      config,
      projectId: "hub",
      runCommand: (invocation) => {
        if (invocation.command === "test -x .venv/bin/pytest") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.kind === "assessment") {
          return {
            status: 0,
            stdout: JSON.stringify({
              score: 72,
              findings: [
                {
                  id: "f1",
                  title: "Extract parser tests",
                  action: "tests",
                  confidence: "high",
                  autofixSafety: "safe",
                  affectedFiles: ["src", "tests"],
                  prompt: "Add focused parser regression tests.",
                  verificationCommands: ["npm test -- tests/parser.test.ts"],
                },
              ],
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "verified", stderr: "" };
      },
      runAgentTask: async (invocation) => {
        agentPrompts.push(invocation.prompt);
        return { status: 0, stdout: "agent handled task", stderr: "" };
      },
      runGit: (invocation) => {
        const command = invocation.args.join(" ");
        if (command === "diff --cached --quiet") {
          return { status: 1, stdout: "", stderr: "" };
        }
        if (command.startsWith("commit -m ")) {
          return { status: 1, stdout: "", stderr: "pre-commit failed" };
        }
        if (command === "status --porcelain") {
          statusChecks++;
          return {
            status: 0,
            stdout: statusChecks === 2 ? "M  tests/parser.test.ts\n M src/parser.ts\n" : "",
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(summary.status).toBe("passed");
    expect(summary.rounds).toEqual([
      expect.objectContaining({
        findingId: "f1",
        status: "committed",
      }),
    ]);
    expect(agentPrompts).toHaveLength(2);
    expect(agentPrompts[1]).toContain("worktree still has verified changes");
    expect(agentPrompts[1]).toContain("tests/parser.test.ts");
    expect(summary.commands.map((command) => command.command)).toContain(
      "agent-post-commit-recovery",
    );
  });

  it("async runner retries once when Codex is running but does not become ready in time", async () => {
    const config = parseLoopConfigYaml(closedLoopConfigText);
    let taskAttempts = 0;

    const summary = await runLoopProjectAsync({
      config,
      projectId: "hub",
      runCommand: (invocation) => {
        if (invocation.command === "test -x .venv/bin/pytest") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.kind === "assessment") {
          return {
            status: 0,
            stdout: JSON.stringify({
              score: 72,
              findings: [
                {
                  id: "f1",
                  title: "Extract parser tests",
                  action: "tests",
                  confidence: "high",
                  autofixSafety: "safe",
                  affectedFiles: ["tests/parser.test.ts"],
                  prompt: "Add focused parser regression tests.",
                  verificationCommands: ["npm test -- tests/parser.test.ts"],
                },
              ],
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "verified", stderr: "" };
      },
      runAgentTask: async () => {
        taskAttempts++;
        return taskAttempts === 1
          ? { status: 1, stdout: "", stderr: "Codex did not become ready in time" }
          : { status: 0, stdout: "agent changed files", stderr: "" };
      },
      runGit: (invocation) => {
        if (invocation.args[0] === "diff") {
          return { status: 1, stdout: "", stderr: "" };
        }
        return {
          status: 0,
          stdout: invocation.args.includes("rev-parse") ? "retry123\n" : "",
          stderr: "",
        };
      },
    });

    expect(summary.status).toBe("passed");
    expect(taskAttempts).toBe(2);
    expect(summary.commands.map((command) => command.command)).toContain("agent-task-ready-retry");
    expect(summary.rounds).toEqual([
      expect.objectContaining({
        findingId: "f1",
        status: "committed",
        commitSha: "retry123",
      }),
    ]);
  });

  it("repairs failed preflight before running assessment", () => {
    const config = parseLoopConfigYaml(closedLoopConfigText);
    const commandInvocations: LoopRunCommandInvocation[] = [];
    const agentPrompts: string[] = [];
    let preflightAttempts = 0;

    const summary = runLoopProject({
      config,
      projectId: "hub",
      runCommand: (invocation) => {
        commandInvocations.push(invocation);
        if (invocation.command === "test -x .venv/bin/pytest") {
          preflightAttempts++;
          return preflightAttempts === 1
            ? { status: 127, stdout: "", stderr: "missing pytest" }
            : { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.kind === "assessment") {
          return { status: 0, stdout: JSON.stringify({ score: 90, findings: [] }), stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      runAgentTask: (invocation) => {
        agentPrompts.push(invocation.prompt);
        return { status: 0, stdout: "environment repaired", stderr: "" };
      },
      runGit: () => ({ status: 0, stdout: "", stderr: "" }),
    });

    expect(summary.status).toBe("passed");
    expect(commandInvocations.map((invocation) => invocation.kind)).toEqual([
      "preflight",
      "preflight",
      "assessment",
    ]);
    expect(agentPrompts).toHaveLength(1);
    expect(agentPrompts[0]).toContain("Repair the local project environment");
  });

  it("recovers a dirty worktree instead of starting a new assessment", () => {
    const config = parseLoopConfigYaml(closedLoopConfigText);
    const agentPrompts: string[] = [];
    const gitCommands: string[][] = [];
    let statusChecks = 0;

    const summary = runLoopProject({
      config,
      projectId: "hub",
      runCommand: () => {
        throw new Error("assessment should not run while worktree is dirty");
      },
      runAgentTask: (invocation) => {
        agentPrompts.push(invocation.prompt);
        return { status: 0, stdout: "dirty slice recovered and committed", stderr: "" };
      },
      runGit: (invocation) => {
        gitCommands.push(invocation.args);
        if (invocation.args.join(" ") === "status --porcelain") {
          statusChecks++;
          return {
            status: 0,
            stdout: statusChecks === 1 ? " M src/index.ts\n" : "",
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(summary.status).toBe("passed");
    expect(summary.rounds).toEqual([
      expect.objectContaining({
        findingId: "dirty-worktree-recovery",
        status: "committed",
      }),
    ]);
    expect(agentPrompts[0]).toContain("dirty worktree");
    expect(agentPrompts[0]).toContain(
      "If project gates or commit hooks fail only because of a dependency advisory",
    );
    expect(gitCommands).toEqual([
      ["status", "--porcelain"],
      ["status", "--porcelain"],
    ]);
    expect(summary.commands.map((command) => command.command)).not.toContain("npm run assess");
  });

  it("fails dirty-worktree recovery when git state cannot be inspected", () => {
    const config = parseLoopConfigYaml(closedLoopConfigText);

    const summary = runLoopProject({
      config,
      projectId: "hub",
      runCommand: () => {
        throw new Error("assessment should not run without git inspection");
      },
      runAgentTask: () => ({ status: 0, stdout: "should not run", stderr: "" }),
    });

    expect(summary.status).toBe("failed");
    expect(summary.rounds).toEqual([
      expect.objectContaining({
        findingId: "dirty-worktree-recovery",
        status: "failed",
        reason: "dirty worktree recovery requires a git adapter",
      }),
    ]);
    expect(summary.commands.map((command) => command.command)).not.toContain("npm run assess");
  });

  it("runs one recovery attempt after verification fails and commits if the retry passes", () => {
    const config = parseLoopConfigYaml(closedLoopConfigText);
    const agentPrompts: string[] = [];
    let verificationAttempts = 0;

    const summary = runLoopProject({
      config,
      projectId: "hub",
      runCommand: (invocation) => {
        if (invocation.command === "test -x .venv/bin/pytest") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (invocation.kind === "assessment") {
          return {
            status: 0,
            stdout: JSON.stringify({
              score: 72,
              findings: [
                {
                  id: "f1",
                  title: "Extract parser tests",
                  action: "tests",
                  confidence: "high",
                  autofixSafety: "safe",
                  affectedFiles: ["tests/parser.test.ts"],
                  prompt: "Add focused parser regression tests.",
                  verificationCommands: ["npm test -- tests/parser.test.ts"],
                },
              ],
            }),
            stderr: "",
          };
        }
        if (invocation.kind === "verification") {
          verificationAttempts++;
          return verificationAttempts === 1
            ? { status: 1, stdout: "", stderr: "lint failed" }
            : { status: 0, stdout: "verified", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      runAgentTask: (invocation) => {
        agentPrompts.push(invocation.prompt);
        return { status: 0, stdout: "agent done", stderr: "" };
      },
      runGit: (invocation) => {
        if (invocation.args[0] === "diff") {
          return { status: 1, stdout: "", stderr: "" };
        }
        return {
          status: 0,
          stdout: invocation.args.includes("rev-parse") ? "def456\n" : "",
          stderr: "",
        };
      },
    });

    expect(summary.status).toBe("passed");
    expect(summary.rounds).toEqual([
      expect.objectContaining({
        findingId: "f1",
        status: "committed",
        commitSha: "def456",
      }),
    ]);
    expect(agentPrompts).toHaveLength(2);
    expect(agentPrompts[1]).toContain("verification failed");
    expect(verificationAttempts).toBe(2);
  });
});
