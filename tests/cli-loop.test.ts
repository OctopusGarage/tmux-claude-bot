import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
    allowedActions: [tests]
`;

const configWithSkillText = `
skills:
  applyCommand: "true"
  catalog:
    - id: improve-codebase-architecture
      sourceUrl: https://github.com/mattpocock/skills
      sourcePath: skills/engineering/improve-codebase-architecture
      trackingRef: main
      platforms: [claude, codex]
      tags: [architecture]
      trustLevel: approved
      risk: medium
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
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
`;

const configWithCatalogOnlyText = `
skills:
  catalog:
    - id: improve-codebase-architecture
      sourceUrl: https://github.com/mattpocock/skills
      sourcePath: skills/engineering/improve-codebase-architecture
      trackingRef: main
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
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
`;

const runnableConfigText = `
projects:
  - id: hub
    name: Hub
    path: __PROJECT_DIR__
    agent: codex
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "printf assessment-ok"
`;

const runnableConfigWithEvalText = `
projects:
  - id: hub
    name: Hub
    path: __PROJECT_DIR__
    agent: codex
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "printf assessment-ok"
    eval:
      command: "printf '%s' '{\\"passed\\":true,\\"score\\":98,\\"findings\\":[],\\"suggestedBotImprovements\\":[\\"Improve loop reports.\\"]}'"
      minScore: 95
`;

const supervisedRunnableConfigText = `
projects:
  - id: hub
    name: Hub
    path: __PROJECT_DIR__
    agent: codex
    runner:
      kind: agent-supervised
      timeoutMs: 1000
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "printf assessment-ok"
`;

const targetsConfigText = `
projects:
  - id: hub
    name: Hub
    path: /repo/hub
    agent: codex
    enabled: true
    schedule: "0 2 * * *"
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
prReview:
  repositories:
    - id: hub-all-prs
      name: Hub all PRs
      path: /repo/hub
      repo: OctopusGarage/hub
      agent: codex
      enabled: true
      schedule: "0 4 * * *"
`;

function runCli(
  args: string[],
  stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-state-")),
  env: Record<string, string> = {},
) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, TCB_STATE_DIR: stateDir },
    encoding: "utf8",
  });
}

function fakeGitBin(ref: string): string {
  const binDir = mkdtempSync(join(tmpdir(), "tcb-loop-fake-git-"));
  const git = join(binDir, "git");
  writeFileSync(
    git,
    `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  printf '%s\\trefs/heads/main\\n' '${ref}'
  exit 0
fi
echo "unexpected git args: $*" >&2
exit 1
`,
  );
  chmodSync(git, 0o755);
  return binDir;
}

describe("CLI loop command", () => {
  it("validates a loop config through the real CLI entrypoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-cli-"));
    const file = join(dir, "loop.yml");
    writeFileSync(file, configText);

    const result = runCli(["loop", "validate", file]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("loop config ok: 1 project(s), 0 approved skill(s)");
    expect(result.stdout).toContain("loop preflight: 0 error(s), 0 warning(s)");
    expect(result.stdout).toContain("- hub: runnable command-assessment command-eval commits-off");
  });

  it("prints JSON validation summaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-cli-"));
    const file = join(dir, "loop.yml");
    writeFileSync(file, configText);

    const result = runCli(["loop", "validate", file, "--json"]);

    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout) as {
      ok: boolean;
      projectCount: number;
      projects: Array<{ id: string; readiness: { runnable: boolean } }>;
    };
    expect(summary.ok).toBe(true);
    expect(summary.projectCount).toBe(1);
    expect(summary.projects[0]).toMatchObject({ id: "hub", readiness: { runnable: true } });
  });

  it("prints due-only tick summaries without executing projects", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-cli-"));
    const file = join(dir, "loop.yml");
    writeFileSync(
      file,
      configText.replace("assessment:", 'schedule: "*/5 * * * *"\n    assessment:'),
    );

    const result = runCli(["loop", "tick", file, "--now", "2026-07-16T10:10:00Z"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "loop tick completed: checked 1, scheduled 1, due 1, executed 0",
    );
    expect(result.stdout).toContain("- hub: would-run at 2026-07-16T10:10:00.000Z");
  });

  it("prints JSON tick summaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-cli-"));
    const file = join(dir, "loop.yml");
    writeFileSync(
      file,
      configText.replace("assessment:", 'schedule: "*/5 * * * *"\n    assessment:'),
    );

    const result = runCli(["loop", "tick", file, "--now", "2026-07-16T10:10:00Z", "--json"]);

    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout) as {
      phase: string;
      due: number;
      executed: number;
      dueProjects: Array<{ projectId: string; action: string }>;
    };
    expect(summary.phase).toBe("due-only");
    expect(summary.due).toBe(1);
    expect(summary.executed).toBe(0);
    expect(summary.dueProjects[0]).toMatchObject({ projectId: "hub", action: "would-run" });
  });

  it("lists and toggles loop targets through the real CLI entrypoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-cli-"));
    const file = join(dir, "loop.yml");
    writeFileSync(file, targetsConfigText);

    const list = runCli(["loop", "targets", "list", file, "--json"]);
    expect(list.status).toBe(0);
    const targets = JSON.parse(list.stdout) as Array<{
      kind: string;
      id: string;
      enabled: boolean;
      scheduled: boolean;
    }>;
    expect(targets).toEqual([
      expect.objectContaining({ kind: "project", id: "hub", enabled: true, scheduled: true }),
      expect.objectContaining({ kind: "repo", id: "hub-all-prs", enabled: true, scheduled: true }),
    ]);

    const disable = runCli(["loop", "targets", "disable", file, "project", "hub", "--json"]);
    expect(disable.status).toBe(0);
    expect(JSON.parse(disable.stdout)).toMatchObject({
      kind: "project",
      id: "hub",
      enabled: false,
      changed: true,
    });

    const enable = runCli(["loop", "targets", "enable", file, "project", "hub", "--json"]);
    expect(enable.status).toBe(0);
    expect(JSON.parse(enable.stdout)).toMatchObject({
      kind: "project",
      id: "hub",
      enabled: true,
      changed: true,
    });
  }, 20_000);

  it("syncs approved skills and lists recorded skill state through the real CLI entrypoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-cli-"));
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-state-"));
    const file = join(dir, "loop.yml");
    writeFileSync(file, configWithSkillText);

    const syncResult = runCli(["loop", "skills", "sync", file], stateDir);
    const listResult = runCli(["loop", "skills", "list", "--json"], stateDir);

    expect(syncResult.status).toBe(0);
    expect(syncResult.stderr).toBe("");
    expect(syncResult.stdout).toContain("loop skills sync completed: actions 1, applied 1");
    expect(listResult.status).toBe(0);
    const skills = JSON.parse(listResult.stdout) as Array<{ skillId: string; status: string }>;
    expect(skills).toEqual([
      expect.objectContaining({
        skillId: "improve-codebase-architecture",
        status: "installed",
      }),
    ]);
  });

  it("prints JSON skill sync summaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-cli-"));
    const file = join(dir, "loop.yml");
    writeFileSync(file, configWithSkillText);

    const result = runCli(["loop", "skills", "sync", file, "--json"]);

    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout) as {
      applied: number;
      actions: Array<{ action: string; skillId: string }>;
    };
    expect(summary.applied).toBe(1);
    expect(summary.actions).toEqual([
      expect.objectContaining({
        action: "install",
        skillId: "improve-codebase-architecture",
      }),
    ]);
  });

  it("refreshes catalog skills from git refs and can write pinned approved specs", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-cli-"));
    const file = join(dir, "loop.yml");
    const ref = "1234567890abcdef1234567890abcdef12345678";
    const binDir = fakeGitBin(ref);
    writeFileSync(file, configWithCatalogOnlyText);

    const result = runCli(["loop", "skills", "refresh", file, "--write", "--json"], undefined, {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout) as {
      phase: string;
      refreshed: number;
      changed: number;
      approved: Array<{ id: string; ref: string; checksum: string; sourcePath: string }>;
    };
    expect(summary.phase).toBe("skill-refresh");
    expect(summary.refreshed).toBe(1);
    expect(summary.changed).toBe(1);
    expect(summary.approved[0]).toMatchObject({
      id: "improve-codebase-architecture",
      ref,
      sourcePath: "skills/engineering/improve-codebase-architecture",
    });
    expect(summary.approved[0]?.checksum).toMatch(/^sha256:/);
    expect(readFileSync(file, "utf8")).toContain(`ref: ${ref}`);
  });

  it("runs deterministic command-backed projects through the real CLI entrypoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-cli-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = join(dir, "loop.yml");
    writeFileSync(file, runnableConfigText.replace("__PROJECT_DIR__", projectDir));

    const textResult = runCli(["loop", "run", file, "hub"]);
    const jsonResult = runCli(["loop", "run", file, "hub", "--json"]);

    expect(textResult.status).toBe(0);
    expect(textResult.stderr).toBe("");
    expect(textResult.stdout).toContain(
      "loop run completed: hub passed, commands 1, committed false",
    );
    expect(textResult.stdout).toContain("- assessment: passed");

    expect(jsonResult.status).toBe(0);
    const summary = JSON.parse(jsonResult.stdout) as {
      phase: string;
      status: string;
      executed: number;
      commands: Array<{ kind: string; status: number; stdout: string }>;
    };
    expect(summary).toMatchObject({
      phase: "command-run",
      status: "passed",
      executed: 1,
    });
    expect(summary.commands).toEqual([
      expect.objectContaining({
        kind: "assessment",
        status: 0,
        stdout: "assessment-ok",
      }),
    ]);
  });

  it("does not route manual agent-supervised runs through the deterministic CLI runner", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-cli-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = join(dir, "loop.yml");
    writeFileSync(file, supervisedRunnableConfigText.replace("__PROJECT_DIR__", projectDir));

    const result = runCli(["loop", "run", file, "hub"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      'loop project "hub" uses runner.kind=agent-supervised; manual CLI runs require the managed Loop Supervisor',
    );
  });

  it("persists run reports and backlog items through the real CLI entrypoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-cli-"));
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = join(dir, "loop.yml");
    writeFileSync(file, runnableConfigWithEvalText.replace("__PROJECT_DIR__", projectDir));

    const runResult = runCli(["loop", "run", file, "hub"], stateDir);
    const reportsResult = runCli(["loop", "reports", "list", "--json"], stateDir);
    const backlogResult = runCli(["loop", "backlog", "list", "--json"], stateDir);

    expect(runResult.status).toBe(0);
    const reports = JSON.parse(reportsResult.stdout) as Array<{
      projectId: string;
      status: string;
    }>;
    expect(reports).toEqual([expect.objectContaining({ projectId: "hub", status: "passed" })]);
    const backlog = JSON.parse(backlogResult.stdout) as Array<{ id: string; text: string }>;
    expect(backlog).toEqual([expect.objectContaining({ text: "Improve loop reports." })]);

    const closeResult = runCli(
      ["loop", "backlog", "close", backlog[0]?.id ?? "", "--json"],
      stateDir,
    );
    const afterCloseResult = runCli(["loop", "backlog", "list", "--json"], stateDir);
    expect(closeResult.status).toBe(0);
    expect(JSON.parse(afterCloseResult.stdout)).toEqual([]);
  }, 20_000);
});
