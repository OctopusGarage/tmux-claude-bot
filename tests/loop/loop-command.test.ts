import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLoopCommand } from "../../src/core/loop/loop-command.js";

const originalStateDir = process.env.TCB_STATE_DIR;
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
  process.env.PATH = originalPath;
});

const configText = `
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

const configWithEvalText = `
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

const configWithSkillsText = `
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
    path: __PROJECT_DIR__
    agent: codex
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "printf assessment-ok"
`;

const configWithTargetsText = `
projects:
  - id: hub
    name: Hub
    path: __PROJECT_DIR__
    agent: codex
    enabled: true
    schedule: "0 2 * * *"
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "printf assessment-ok"
workspaces:
  - id: geo
    name: Geo Workspace
    root: /repo/geo
    agent: codex
    enabled: true
    repositories:
      - id: backend
        name: Backend
        path: /repo/geo/backend
        role: backend
      - id: frontend
        name: Frontend
        path: /repo/geo/frontend
        role: frontend
    architecture:
      enabled: true
      schedule: "30 3 * * *"
      goal: Improve workspace boundaries.
prReview:
  repositories:
    - id: hub-all-prs
      name: Hub all PRs
      path: __PROJECT_DIR__
      repo: OctopusGarage/hub
      agent: codex
      enabled: true
      schedule: "0 4 * * *"
`;

function tempFile(text: string): { file: string; projectDir: string; stateDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "tcb-loop-command-"));
  const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
  const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-state-"));
  const file = join(dir, "loop.yml");
  writeFileSync(file, text.replaceAll("__PROJECT_DIR__", projectDir));
  process.env.TCB_STATE_DIR = stateDir;
  return { file, projectDir, stateDir };
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

describe("runLoopCommand", () => {
  it("validates configs and reports usage errors", () => {
    const { file } = tempFile(configText);

    expect(runLoopCommand(["validate"]).stderr).toBe("Usage: loop validate <file> [--json]");
    expect(runLoopCommand(["validate", file, "--bad"]).stderr).toContain(
      'unknown loop validate option "--bad"',
    );

    const text = runLoopCommand(["validate", file]);
    expect(text).toMatchObject({ exitCode: 0 });
    expect(text.stdout).toContain("loop config ok: 1 project(s), 0 approved skill(s)");

    const json = runLoopCommand(["validate", file, "--json"]);
    expect(JSON.parse(json.stdout ?? "{}")).toMatchObject({ ok: true, projectCount: 1 });
  });

  it("ticks scheduled projects and validates tick arguments", () => {
    const { file } = tempFile(
      configText.replace("assessment:", 'schedule: "*/5 * * * *"\n    assessment:'),
    );

    expect(runLoopCommand(["tick"]).stderr).toBe("Usage: loop tick <file> [--now <time>] [--json]");
    expect(runLoopCommand(["tick", file, "--now"]).stderr).toBe("loop tick --now requires a value");
    expect(runLoopCommand(["tick", file, "--wat"]).stderr).toContain("unknown loop tick option");
    expect(runLoopCommand(["tick", file, "--now", "not-a-time"]).stderr).toContain("invalid time");

    const text = runLoopCommand(["tick", file, "--now", "2026-07-16T10:10:00Z"]);
    expect(text).toMatchObject({ exitCode: 0 });
    expect(text.stdout).toContain("loop tick completed: checked 1, scheduled 1, due 1, executed 0");

    const json = runLoopCommand(["tick", file, "--now", "2026-07-16T10:10:00Z", "--json"]);
    expect(JSON.parse(json.stdout ?? "{}")).toMatchObject({ phase: "due-only", due: 1 });
  });

  it("runs command-backed projects and records reports plus backlog items", () => {
    const { file, stateDir } = tempFile(configWithEvalText);

    expect(runLoopCommand(["run"]).stderr).toBe("Usage: loop run <file> <projectId> [--json]");
    expect(runLoopCommand(["run", file, "hub", "--bad"]).stderr).toContain(
      "unknown loop run option",
    );

    const run = runLoopCommand(["run", file, "hub"]);
    expect(run).toMatchObject({ exitCode: 0 });
    expect(run.stdout).toContain("loop run completed: hub passed, commands 2, committed false");

    const reports = runLoopCommand(["reports", "list", "--json"]);
    expect(JSON.parse(reports.stdout ?? "{}")).toMatchObject({
      items: [expect.objectContaining({ projectId: "hub", status: "passed" })],
      total: 1,
      truncated: false,
    });

    const backlogResult = JSON.parse(
      runLoopCommand(["backlog", "list", "--json"]).stdout ?? "{}",
    ) as {
      items: Array<{
        id: string;
        text: string;
      }>;
    };
    const backlog = backlogResult.items;
    expect(backlog).toEqual([expect.objectContaining({ text: "Improve loop reports." })]);
    expect(runLoopCommand(["backlog", "list", "--all"]).stdout).toContain("loop backlog: 1");

    const close = runLoopCommand(["backlog", "close", backlog[0]?.id ?? "", "--json"]);
    expect(JSON.parse(close.stdout ?? "{}")).toMatchObject({ closed: true });
    expect(runLoopCommand(["backlog", "close", "missing"]).exitCode).toBe(1);

    process.env.TCB_STATE_DIR = stateDir;
    expect(runLoopCommand(["reports", "bad"]).stderr).toContain("Usage: loop reports list");
    expect(runLoopCommand(["backlog", "wat"]).stderr).toContain("Usage: loop backlog list");
  });

  it("shows eval outcome in loop report listings", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-command-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const runDir = join(stateDir, "loop-runs", "hub", "run-supervisor");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "supervisor-summary.json"),
      `${JSON.stringify({
        runId: "run-supervisor",
        project: { id: "hub", name: "Hub" },
        status: "completed",
        timestamps: { startedAt: 1_000, endedAt: 2_000 },
        evalReportPath: join(runDir, "eval-report.json"),
      })}\n`,
    );
    writeFileSync(
      join(runDir, "eval-report.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        source: {
          kind: "work-order-final-summary",
          workOrderId: "run-supervisor",
          projectId: "hub",
        },
        executionBoundary: "worker-internal",
        outcome: { status: "passed", finalVerification: "passed" },
        evidence: [],
        deterministicGates: [],
        notes: [],
        learningCandidates: {
          regression: [],
          capability: [],
          monitorOrTrace: [],
          documentation: [],
        },
      })}\n`,
    );

    const jsonReports = JSON.parse(runLoopCommand(["reports", "list", "--json"]).stdout ?? "{}");
    expect(jsonReports).toMatchObject({
      items: [
        expect.objectContaining({
          runId: "run-supervisor",
          evalOutcome: { status: "passed", finalVerification: "passed" },
        }),
      ],
    });
    expect(runLoopCommand(["reports", "list"]).stdout).toContain(
      "- hub: passed run-supervisor eval=passed",
    );
  });

  it("rejects manual agent-supervised runs", () => {
    const { file } = tempFile(
      configText.replace(
        "goal:",
        "runner:\n      kind: agent-supervised\n      timeoutMs: 1000\n    goal:",
      ),
    );

    const result = runLoopCommand(["run", file, "hub"]);

    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.stderr).toContain("manual CLI runs require the managed Loop Supervisor");
  });

  it("lists, syncs, and refreshes loop skills", () => {
    const ref = "1234567890abcdef1234567890abcdef12345678";
    process.env.PATH = `${fakeGitBin(ref)}:${originalPath ?? ""}`;
    const { file } = tempFile(configWithSkillsText);

    expect(runLoopCommand(["skills", "wat"]).stderr).toContain("Usage: loop skills list");
    expect(runLoopCommand(["skills", "list", "--bad"]).stderr).toContain(
      "unknown loop skills list option",
    );
    expect(runLoopCommand(["skills", "sync"]).stderr).toBe(
      "Usage: loop skills sync <file> [--json]",
    );
    expect(runLoopCommand(["skills", "sync", file, "--bad"]).stderr).toContain(
      "unknown loop skills sync option",
    );

    const sync = runLoopCommand(["skills", "sync", file, "--json"]);
    expect(JSON.parse(sync.stdout ?? "{}")).toMatchObject({ phase: "skill-sync", applied: 1 });
    expect(runLoopCommand(["skills", "list"]).stdout).toContain("loop skills: 1 recorded");
    expect(JSON.parse(runLoopCommand(["skills", "list", "--json"]).stdout ?? "[]")).toEqual([
      expect.objectContaining({
        skillId: "improve-codebase-architecture",
        status: "installed",
      }),
    ]);

    expect(runLoopCommand(["skills", "refresh"]).stderr).toBe(
      "Usage: loop skills refresh <file> [--write] [--json]",
    );
    expect(runLoopCommand(["skills", "refresh", file, "--bad"]).stderr).toContain(
      "unknown loop skills refresh option",
    );
    const beforeRefresh = readFileSync(file, "utf8");
    const dryRunRefresh = runLoopCommand(["skills", "refresh", file]);
    expect(dryRunRefresh.stdout).toContain("loop skills refresh completed: refreshed 1, changed 1");
    expect(readFileSync(file, "utf8")).toBe(beforeRefresh);

    const refresh = runLoopCommand(["skills", "refresh", file, "--write", "--json"]);
    expect(JSON.parse(refresh.stdout ?? "{}")).toMatchObject({
      phase: "skill-refresh",
      refreshed: 1,
      changed: 1,
    });
    expect(readFileSync(file, "utf8")).toContain(`ref: ${ref}`);
  });

  it("lists and toggles loop targets without deleting schedules", () => {
    const { file } = tempFile(configWithTargetsText);

    expect(runLoopCommand(["targets"]).stderr).toContain("Usage: loop targets list");
    expect(runLoopCommand(["targets", "list"]).stderr).toContain("Usage: loop targets list");
    expect(runLoopCommand(["targets", "list", file, "--bad"]).stderr).toContain(
      "unknown loop targets list option",
    );
    expect(
      runLoopCommand(["targets", "disable", file, "repo", "hub-all-prs", "--bad"]).stderr,
    ).toContain('unknown loop targets disable option "--bad"');
    expect(
      runLoopCommand(["targets", "enable", file, "repo", "hub-all-prs", "--bad"]).stderr,
    ).toContain('unknown loop targets enable option "--bad"');
    expect(runLoopCommand(["targets", "list", file]).stdout).toContain(
      "- project:hub: enabled scheduled jobs=architecture",
    );

    const listed = JSON.parse(
      runLoopCommand(["targets", "list", file, "--json"]).stdout ?? "[]",
    ) as Array<{ kind: string; id: string; enabled: boolean; scheduled: boolean }>;
    expect(listed).toEqual([
      expect.objectContaining({ kind: "project", id: "hub", enabled: true, scheduled: true }),
      expect.objectContaining({ kind: "workspace", id: "geo", enabled: true, scheduled: true }),
      expect.objectContaining({ kind: "repo", id: "hub-all-prs", enabled: true, scheduled: true }),
    ]);

    expect(runLoopCommand(["targets", "disable"]).stderr).toBe(
      "Usage: loop targets <enable|disable> <file> <project|workspace|repo> <id> [--json]",
    );
    expect(runLoopCommand(["targets", "disable", file, "unknown", "hub"]).stderr).toContain(
      'unknown loop target kind "unknown"',
    );
    expect(runLoopCommand(["targets", "disable", file, "project", "missing"]).stderr).toContain(
      'loop target not found: project "missing"',
    );

    const disabled = runLoopCommand(["targets", "disable", file, "repo", "hub-all-prs", "--json"]);
    expect(JSON.parse(disabled.stdout ?? "{}")).toMatchObject({
      kind: "repo",
      id: "hub-all-prs",
      enabled: false,
      changed: true,
    });
    expect(readFileSync(file, "utf8")).toContain("enabled: false");
    expect(readFileSync(file, "utf8")).toContain("schedule: 0 4 * * *");

    const afterDisable = JSON.parse(
      runLoopCommand(["targets", "list", file, "--json"]).stdout ?? "[]",
    ) as Array<{ kind: string; id: string; enabled: boolean; scheduled: boolean }>;
    expect(afterDisable.find((target) => target.id === "hub-all-prs")).toMatchObject({
      enabled: false,
      scheduled: false,
    });

    const enabled = runLoopCommand(["targets", "enable", file, "repo", "hub-all-prs", "--json"]);
    expect(JSON.parse(enabled.stdout ?? "{}")).toMatchObject({
      kind: "repo",
      id: "hub-all-prs",
      enabled: true,
      changed: true,
    });
    expect(runLoopCommand(["targets", "enable", file, "repo", "hub-all-prs"]).stdout).toBe(
      "loop target enable: repo:hub-all-prs unchanged",
    );
  });

  it("handles unknown commands and parse errors", () => {
    const { file } = tempFile("projects: [");

    expect(runLoopCommand([]).stderr).toContain("Usage: loop validate");
    expect(runLoopCommand(["validate", file]).stderr).toContain("invalid YAML");
  });
});
