import { describe, expect, it } from "vitest";
import { parseLoopConfigYaml, validateLoopConfig } from "../../src/core/loop/config.js";

const validConfig = `
skills:
  applyCommand: ./scripts/sync-agent-skill.sh
  catalog:
    - id: code-review
      sourceUrl: https://github.com/mattpocock/skills
      sourcePath: skills/engineering/code-review
      trackingRef: main
      platforms: [claude, codex]
      tags: [review]
      trustLevel: approved
      risk: low
      updatePolicy: notify
  approved:
    - id: improve-codebase-architecture
      sourceUrl: https://github.com/mattpocock/skills
      sourcePath: skills/engineering/improve-codebase-architecture
      ref: 2f3c4d5e6a
      checksum: sha256:abc
      platforms: [claude, codex]
      tags: [architecture]
      trustLevel: approved
      risk: medium
      updatePolicy: notify
projects:
  - id: hub
    name: Hub
    path: /repo/hub
    agent: codex
    schedule: "0 2 * * *"
    goal: Improve core module clarity in small verified slices.
    maxRounds: 3
    targetScore: 90
    assessment:
      command: npm run assess
    eval:
      command: npm run loop-eval
      minScore: 95
    commit:
      enabled: false
      perRound: true
    allowedActions: [tests, docs, small-refactor]
    blockedActions: [direct-model-api, dependency-upgrade, broad-rewrite]
    selfImprovement:
      enabled: true
      maxItemsPerRun: 5
`;

describe("parseLoopConfigYaml", () => {
  it("parses the first-phase loop config shape", () => {
    const config = parseLoopConfigYaml(validConfig);

    expect(config.scheduler.jitter).toEqual({
      enabled: false,
      seed: "loop-engineering",
      architectureMaxDelayMinutes: 0,
      bugFixMaxDelayMinutes: 0,
      testCoverageMaxDelayMinutes: 0,
      securityMaintenanceMaxDelayMinutes: 0,
      pullRequestReviewMaxDelayMinutes: 0,
      repositoryPullRequestReviewMaxDelayMinutes: 0,
    });
    expect(config.skills.approved[0]).toMatchObject({
      id: "improve-codebase-architecture",
      sourcePath: "skills/engineering/improve-codebase-architecture",
      platforms: ["claude", "codex"],
      updatePolicy: "notify",
    });
    expect(config.skills.catalog[0]).toMatchObject({
      id: "code-review",
      sourcePath: "skills/engineering/code-review",
      trackingRef: "main",
      platforms: ["claude", "codex"],
    });
    expect(config.projects[0]).toMatchObject({
      id: "hub",
      agent: "codex",
      maxRounds: 3,
      targetScore: 90,
      execution: { agent: false },
      assessment: { command: "npm run assess" },
      eval: { command: "npm run loop-eval", minScore: 95 },
      commit: { enabled: false, perRound: true },
    });
  });

  it("parses scheduler jitter defaults and per-job overrides", () => {
    const config = parseLoopConfigYaml(`scheduler:
  jitter:
    enabled: true
    seed: local-stable
    architectureMaxDelayMinutes: 10
    bugFixMaxDelayMinutes: 20
    testCoverageMaxDelayMinutes: 25
    securityMaintenanceMaxDelayMinutes: 28
    pullRequestReviewMaxDelayMinutes: 30
    repositoryPullRequestReviewMaxDelayMinutes: 45
${validConfig.replace(
  '    schedule: "0 2 * * *"',
  '    schedule: "0 2 * * *"\n    scheduleJitterMinutes: 7',
)}
prReview:
  repositories:
    - id: mesh-talk-all-prs
      name: mesh-talk all PRs
      path: /repo/mesh-talk
      repo: OctopusGarage/mesh-talk
      agent: codex
      schedule: "45 3 * * *"
      scheduleJitterMinutes: 12
      switchBack: dev
`);

    expect(config.scheduler.jitter).toEqual({
      enabled: true,
      seed: "local-stable",
      architectureMaxDelayMinutes: 10,
      bugFixMaxDelayMinutes: 20,
      testCoverageMaxDelayMinutes: 25,
      securityMaintenanceMaxDelayMinutes: 28,
      pullRequestReviewMaxDelayMinutes: 30,
      repositoryPullRequestReviewMaxDelayMinutes: 45,
    });
    expect(config.projects[0]?.scheduleJitterMinutes).toBe(7);
    expect(config.prReview.repositories[0]?.scheduleJitterMinutes).toBe(12);
  });

  it("parses test coverage jobs for meaningful coverage improvement", () => {
    const text = validConfig.replace(
      "allowedActions:",
      [
        "testCoverage:",
        "      enabled: true",
        '      schedule: "20 14 * * *"',
        "      scheduleJitterMinutes: 8",
        "      branch: loop/hub/test-coverage",
        "      targetCoverage: 80",
        "      maxRounds: 5",
        "      requireMeaningfulTests: true",
        "      allowIntegrationTests: true",
        "      allowSmokeTests: true",
        "      allowE2ETests: false",
        "      allowAiEvalTests: false",
        "      prompt: Focus on critical service behavior.",
        "    runner:",
        "      kind: agent-supervised",
        "    allowedActions:",
      ].join("\n"),
    );
    const config = parseLoopConfigYaml(text);
    const project = config.projects[0];

    expect(project?.testCoverage).toMatchObject({
      enabled: true,
      schedule: "20 14 * * *",
      scheduleJitterMinutes: 8,
      branch: "loop/hub/test-coverage",
      targetCoverage: 80,
      maxRounds: 5,
      requireMeaningfulTests: true,
      allowIntegrationTests: true,
      allowSmokeTests: true,
      allowE2ETests: false,
      allowAiEvalTests: false,
      prompt: "Focus on critical service behavior.",
    });
    expect(validateLoopConfig(text).projects[0]?.scheduledJobs).toContain("test-coverage");
  });

  it("requires test coverage jobs to use agent supervision", () => {
    expect(() =>
      parseLoopConfigYaml(
        validConfig.replace(
          "allowedActions:",
          [
            "testCoverage:",
            "      enabled: true",
            '      schedule: "20 14 * * *"',
            "    allowedActions:",
          ].join("\n"),
        ),
      ),
    ).toThrow(/testCoverage requires runner.kind=agent-supervised/i);
  });

  it("parses security maintenance jobs for confirmed security fixes", () => {
    const text = validConfig.replace(
      "allowedActions:",
      [
        "securityMaintenance:",
        "      enabled: true",
        '      schedule: "10 16 * * *"',
        "      scheduleJitterMinutes: 11",
        "      branch: loop/hub/security-maintenance",
        "      maxRounds: 4",
        "      allowDependencyUpdates: true",
        "      allowConfigHardening: true",
        "      allowStaticAnalysisFixes: false",
        "      prompt: Prioritize reachable auth and supply-chain findings.",
        "    runner:",
        "      kind: agent-supervised",
        "    allowedActions:",
      ].join("\n"),
    );
    const config = parseLoopConfigYaml(text);
    const project = config.projects[0];

    expect(project?.securityMaintenance).toMatchObject({
      enabled: true,
      schedule: "10 16 * * *",
      scheduleJitterMinutes: 11,
      branch: "loop/hub/security-maintenance",
      maxRounds: 4,
      allowDependencyUpdates: true,
      allowConfigHardening: true,
      allowStaticAnalysisFixes: false,
      prompt: "Prioritize reachable auth and supply-chain findings.",
    });
    expect(validateLoopConfig(text).projects[0]?.scheduledJobs).toContain("security-maintenance");
  });

  it("requires security maintenance jobs to use agent supervision", () => {
    expect(() =>
      parseLoopConfigYaml(
        validConfig.replace(
          "allowedActions:",
          [
            "securityMaintenance:",
            "      enabled: true",
            '      schedule: "10 16 * * *"',
            "    allowedActions:",
          ].join("\n"),
        ),
      ),
    ).toThrow(/securityMaintenance requires runner.kind=agent-supervised/i);
  });

  it("parses workspace architecture jobs for multi-repository optimization", () => {
    const config = parseLoopConfigYaml(`${validConfig}
workspaces:
  - id: geo
    name: Geo Workspace
    root: /repo/realestate
    agent: codex
    repositories:
      - id: geo-backend
        name: Geo Backend
        path: /repo/realestate/geo-backend
        role: backend
        pullRequest:
          enabled: true
          base: main
          switchBack: main
      - id: geo-frontend
        name: Geo Frontend
        path: /repo/realestate/geo-frontend
        role: frontend
        pullRequest:
          enabled: true
          base: main
          switchBack: main
    architecture:
      enabled: true
      schedule: "10 11 * * *"
      scheduleJitterMinutes: 9
      goal: Improve frontend/backend architecture together.
      maxRounds: 3
      targetScore: 95
      runner:
        kind: agent-supervised
`);

    expect(config.workspaces[0]).toMatchObject({
      id: "geo",
      root: "/repo/realestate",
      agent: "codex",
      architecture: {
        enabled: true,
        schedule: "10 11 * * *",
        scheduleJitterMinutes: 9,
        maxRounds: 3,
        targetScore: 95,
        runner: { kind: "agent-supervised", requireConfirmation: false },
      },
      repositories: [
        {
          id: "geo-backend",
          role: "backend",
          pullRequest: { enabled: true, base: "main", switchBack: "main" },
        },
        {
          id: "geo-frontend",
          role: "frontend",
          pullRequest: { enabled: true, base: "main", switchBack: "main" },
        },
      ],
    });
  });

  it("allows a config that only schedules workspace architecture", () => {
    const config = parseLoopConfigYaml(`
workspaces:
  - id: geo
    name: Geo Workspace
    root: /repo/realestate
    agent: codex
    repositories:
      - id: geo-backend
        name: Geo Backend
        path: /repo/realestate/geo-backend
        role: backend
      - id: geo-frontend
        name: Geo Frontend
        path: /repo/realestate/geo-frontend
        role: frontend
    architecture:
      enabled: true
      schedule: "10 11 * * *"
      goal: Improve frontend/backend architecture together.
`);

    expect(config.projects).toEqual([]);
    expect(config.workspaces[0]?.id).toBe("geo");
  });

  it("rejects an empty loop config", () => {
    expect(() => parseLoopConfigYaml("{}")).toThrow(
      /at least one project, workspace, or prReview repository is required/i,
    );
  });

  it("requires workspace architecture jobs to use agent supervision", () => {
    expect(() =>
      parseLoopConfigYaml(`${validConfig}
workspaces:
  - id: geo
    name: Geo Workspace
    root: /repo/realestate
    agent: codex
    repositories:
      - id: geo-backend
        name: Geo Backend
        path: /repo/realestate/geo-backend
        role: backend
      - id: geo-frontend
        name: Geo Frontend
        path: /repo/realestate/geo-frontend
        role: frontend
    architecture:
      enabled: true
      schedule: "10 11 * * *"
      goal: Improve frontend/backend architecture together.
      runner:
        kind: system
`),
    ).toThrow(/workspace.*requires runner.kind=agent-supervised/i);
  });

  it("rejects unsupported agent-backed assessment in phase one", () => {
    expect(() =>
      parseLoopConfigYaml(validConfig.replace("command: npm run assess", "agent: true")),
    ).toThrow(/assessment.agent is not implemented/i);
  });

  it("accepts agent-backed eval for active-agent evaluation", () => {
    const config = parseLoopConfigYaml(
      validConfig.replace(
        "command: npm run loop-eval\n      minScore: 95",
        "agent: true\n      minScore: 95",
      ),
    );

    expect(config.projects[0]?.eval).toMatchObject({ agent: true, minScore: 95 });
    const summary = validateLoopConfig(
      validConfig.replace(
        "command: npm run loop-eval\n      minScore: 95",
        "agent: true\n      minScore: 95",
      ),
    );
    expect(summary.projects[0]?.eval).toEqual({ mode: "agent", minScore: 95 });
  });

  it("rejects floating approved skill refs", () => {
    expect(() => parseLoopConfigYaml(validConfig.replace("ref: 2f3c4d5e6a", "ref: main"))).toThrow(
      /floating skill ref/i,
    );
  });

  it("requires eval minScore to be at least targetScore", () => {
    expect(() => parseLoopConfigYaml(validConfig.replace("minScore: 95", "minScore: 80"))).toThrow(
      /eval.minScore must be >= targetScore/i,
    );
  });

  it("parses explicit agent execution opt-in", () => {
    const config = parseLoopConfigYaml(
      validConfig.replace("allowedActions:", "execution:\n      agent: true\n    allowedActions:"),
    );

    expect(config.projects[0]?.execution).toEqual({ agent: true });
  });

  it("defaults loop project runner to system", () => {
    const config = parseLoopConfigYaml(validConfig);

    expect(config.projects[0]?.runner).toEqual({ kind: "system" });
  });

  it("parses agent-supervised runner options", () => {
    const config = parseLoopConfigYaml(
      validConfig.replace(
        "allowedActions:",
        [
          "runner:",
          "      kind: agent-supervised",
          "      timeoutMs: 7200000",
          "      maxTurns: 20",
          "      requireConfirmation: true",
          "    allowedActions:",
        ].join("\n"),
      ),
    );

    expect(config.projects[0]?.runner).toEqual({
      kind: "agent-supervised",
      timeoutMs: 7200000,
      maxTurns: 20,
      requireConfirmation: true,
    });
  });

  it("parses a pull request GitHub account override", () => {
    const config = parseLoopConfigYaml(
      validConfig.replace(
        "allowedActions:",
        [
          "pullRequest:",
          "      enabled: true",
          "      base: dev",
          "      switchBack: dev",
          "      autoMerge: true",
          "      githubAccount: Kingson4Wu",
          "    allowedActions:",
        ].join("\n"),
      ),
    );

    expect(config.projects[0]?.pullRequest).toMatchObject({
      enabled: true,
      base: "dev",
      switchBack: "dev",
      autoMerge: true,
      githubAccount: "Kingson4Wu",
    });
  });

  it("parses scheduled pull request review controls", () => {
    const config = parseLoopConfigYaml(
      validConfig.replace(
        "allowedActions:",
        [
          "runner:",
          "      kind: agent-supervised",
          "    pullRequest:",
          "      enabled: true",
          "      base: main",
          "      switchBack: main",
          "    pullRequestReview:",
          "      enabled: true",
          '      schedule: "30 9 * * *"',
          "      lookbackHours: 36",
          "      consecutivePasses: 2",
          "      autoMerge: true",
          "      prompt: Focus on bugs, CI, mergeability, and user-visible regressions.",
          "    allowedActions:",
        ].join("\n"),
      ),
    );

    expect(config.projects[0]?.pullRequestReview).toEqual({
      enabled: true,
      schedule: "30 9 * * *",
      lookbackHours: 36,
      consecutivePasses: 2,
      autoMerge: true,
      prompt: "Focus on bugs, CI, mergeability, and user-visible regressions.",
    });
    const text = validConfig.replace(
      "allowedActions:",
      [
        "runner:",
        "      kind: agent-supervised",
        "    pullRequest:",
        "      enabled: true",
        "      base: main",
        "      switchBack: main",
        "    pullRequestReview:",
        "      enabled: true",
        '      schedule: "30 9 * * *"',
        "      lookbackHours: 36",
        "      consecutivePasses: 2",
        "      autoMerge: true",
        "      prompt: Focus on bugs, CI, mergeability, and user-visible regressions.",
        "    allowedActions:",
      ].join("\n"),
    );

    expect(validateLoopConfig(text).projects[0]?.scheduledJobs).toEqual([
      "architecture",
      "pull-request-review",
    ]);
  });

  it("parses scheduled bug-fix controls separately from architecture", () => {
    const config = parseLoopConfigYaml(
      validConfig.replace(
        "allowedActions:",
        [
          "runner:",
          "      kind: agent-supervised",
          "    bugFix:",
          "      enabled: true",
          '      schedule: "45 10 * * *"',
          "      scheduleJitterMinutes: 9",
          "      branch: loop/datavibe/bug-fix",
          "      maxRounds: 4",
          "      maxBugsPerRound: 1",
          "      requireRegressionTest: true",
          "      prompt: Only fix proven production-risk bugs.",
          "    allowedActions:",
        ].join("\n"),
      ),
    );

    expect(config.projects[0]?.bugFix).toEqual({
      enabled: true,
      schedule: "45 10 * * *",
      scheduleJitterMinutes: 9,
      branch: "loop/datavibe/bug-fix",
      maxRounds: 4,
      maxBugsPerRound: 1,
      requireRegressionTest: true,
      prompt: "Only fix proven production-risk bugs.",
    });
    const summary = validateLoopConfig(
      validConfig.replace(
        "allowedActions:",
        [
          "runner:",
          "      kind: agent-supervised",
          "    bugFix:",
          "      enabled: true",
          '      schedule: "45 10 * * *"',
          "    allowedActions:",
        ].join("\n"),
      ),
    );
    expect(summary.projects[0]?.scheduledJobs).toEqual(["architecture", "bug-fix"]);
  });

  it("requires scheduled bug-fix jobs to use the supervised runner", () => {
    expect(() =>
      parseLoopConfigYaml(
        validConfig.replace(
          "allowedActions:",
          [
            "bugFix:",
            "      enabled: true",
            '      schedule: "45 10 * * *"',
            "    allowedActions:",
          ].join("\n"),
        ),
      ),
    ).toThrow(/bugFix requires runner.kind=agent-supervised/i);
  });

  it("parses repository-wide pull request review jobs", () => {
    const config = parseLoopConfigYaml(`${validConfig}
prReview:
  repositories:
    - id: tmux-claude-bot
      name: tmux-claude-bot
      path: /repo/tmux-claude-bot
      repo: OctopusGarage/tmux-claude-bot
      agent: codex
      schedule: "0 2 * * *"
      base: dev
      githubAccount: Kingson4Wu
      lookbackHours: 72
      consecutivePasses: 2
      autoMerge: true
      repair:
        enabled: true
        maxAttempts: 1
        prompt: Only repair small deterministic check failures.
      prompt: Review all open PRs. Focus on introduced bugs, CI, and mergeability.
`);

    expect(config.prReview.repositories[0]).toMatchObject({
      id: "tmux-claude-bot",
      repo: "OctopusGarage/tmux-claude-bot",
      base: "dev",
      switchBack: "dev",
      githubAccount: "Kingson4Wu",
      autoMerge: true,
      repair: {
        enabled: true,
        maxAttempts: 1,
        prompt: "Only repair small deterministic check failures.",
      },
      runner: { kind: "agent-supervised", requireConfirmation: false },
    });
  });

  it("treats a repository-wide pull request review without base as all open PRs", () => {
    const config = parseLoopConfigYaml(`${validConfig}
prReview:
  repositories:
    - id: mesh-talk-all-prs
      name: mesh-talk all PRs
      path: /repo/mesh-talk
      repo: OctopusGarage/mesh-talk
      agent: codex
      schedule: "0 2 * * *"
      switchBack: dev
      githubAccount: Kingson4Wu
      autoMerge: true
`);

    expect(config.prReview.repositories[0]).toMatchObject({
      id: "mesh-talk-all-prs",
      repo: "OctopusGarage/mesh-talk",
      switchBack: "dev",
      githubAccount: "Kingson4Wu",
      autoMerge: true,
    });
    expect(config.prReview.repositories[0]?.base).toBeUndefined();
  });

  it("rejects unknown runner keys", () => {
    expect(() =>
      parseLoopConfigYaml(
        validConfig.replace(
          "allowedActions:",
          ["runner:", "      kind: system", "      surprise: true", "    allowedActions:"].join(
            "\n",
          ),
        ),
      ),
    ).toThrow(/projects\.0\.runner: Unrecognized key/i);
  });

  it("parses closed-loop preflight and recovery controls", () => {
    const config = parseLoopConfigYaml(
      validConfig.replace(
        "allowedActions:",
        [
          "preflight:",
          "      commands:",
          "        - test -x .venv/bin/pytest",
          "      repair:",
          "        agent: true",
          "        prompt: Repair this project environment using its own setup docs.",
          "    recovery:",
          "      agent: true",
          "      dirtyWorktree: true",
          "      maxAttempts: 1",
          "    allowedActions:",
        ].join("\n"),
      ),
    );

    expect(config.projects[0]?.preflight).toEqual({
      commands: ["test -x .venv/bin/pytest"],
      repair: {
        agent: true,
        prompt: "Repair this project environment using its own setup docs.",
      },
    });
    expect(config.projects[0]?.recovery).toEqual({
      agent: true,
      dirtyWorktree: true,
      maxAttempts: 1,
    });
  });

  it("rejects unknown nested config keys instead of silently dropping them", () => {
    expect(() =>
      parseLoopConfigYaml(
        validConfig.replace(
          "allowedActions:",
          ["preflight:", "      command: test -x .venv/bin/pytest", "    allowedActions:"].join(
            "\n",
          ),
        ),
      ),
    ).toThrow(/projects\.0\.preflight: Unrecognized key/i);
  });
});

describe("validateLoopConfig", () => {
  it("returns a stable preflight summary without executing anything", () => {
    const result = validateLoopConfig(validConfig);

    expect(result.ok).toBe(true);
    expect(result.projectCount).toBe(1);
    expect(result.approvedSkillCount).toBe(1);
    expect(result.catalogSkillCount).toBe(1);
    expect(result.phase).toBe("validate-only");
    expect(result.readinessSummary).toEqual({
      runnableProjectCount: 1,
      scheduledProjectCount: 1,
      issueCount: 0,
      errorCount: 0,
      warningCount: 0,
    });
    expect(result.projects[0]).toMatchObject({
      id: "hub",
      scheduled: true,
      assessment: { mode: "command" },
      eval: { mode: "command", minScore: 95 },
      execution: { agent: false },
      runner: { kind: "system" },
      commit: { enabled: false, perRound: true },
      readiness: { runnable: true, issueCount: 0 },
    });
    expect(result.skills.catalog).toEqual([
      expect.objectContaining({
        id: "code-review",
        sourcePath: "skills/engineering/code-review",
        trackingRef: "main",
      }),
    ]);
  });
});
