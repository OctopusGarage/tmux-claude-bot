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
