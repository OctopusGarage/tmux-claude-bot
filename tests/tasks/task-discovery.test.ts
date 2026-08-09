import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverLaunchdScheduledTasks,
  discoverLoopEngineeringScheduledTasks,
  mergeDiscoveredTaskRecords,
} from "../../src/core/tasks/task-discovery.js";
import type { ScheduledTaskRecord } from "../../src/core/tasks/task-ledger.js";
import { singaporeDayWindow } from "../../src/core/tasks/task-ledger.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

function plist(input: {
  label: string;
  stdout?: string;
  stderr?: string;
  interval?: number;
}): string {
  const out = input.stdout ? `<key>StandardOutPath</key><string>${input.stdout}</string>` : "";
  const err = input.stderr ? `<key>StandardErrorPath</key><string>${input.stderr}</string>` : "";
  const interval = input.interval
    ? `<key>StartInterval</key><integer>${input.interval}</integer>`
    : "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${input.label}</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>echo ok</string></array>
${interval}
${out}
${err}
</dict></plist>`;
}

describe("discoverLaunchdScheduledTasks", () => {
  it("discovers launchd scheduled tasks as expected even when they never report", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-launchd-discovery-"));
    const launchAgents = join(root, "LaunchAgents");
    mkdirSync(launchAgents);
    writeFileSync(
      join(launchAgents, "com.example.daily.plist"),
      plist({ label: "com.example.daily" }),
    );

    const records = discoverLaunchdScheduledTasks({
      dirs: [launchAgents],
      window: singaporeDayWindow("2026-07-27"),
      now: Date.parse("2026-07-28T02:00:00Z"),
    });

    expect(records).toEqual([
      expect.objectContaining({
        taskId: "launchd:com.example.daily:2026-07-27 SGT",
        source: "launchd",
        status: "expected",
        name: "launchd com.example.daily",
      }),
    ]);
  });

  it("marks a launchd task failed when its stderr log changed in the audited window", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-launchd-discovery-"));
    const launchAgents = join(root, "LaunchAgents");
    const logs = join(root, "logs");
    mkdirSync(launchAgents);
    mkdirSync(logs);
    const errPath = join(logs, "daily.err.log");
    writeFileSync(errPath, "2026-07-27T03:00:00Z ERROR report was not generated\n");
    writeFileSync(
      join(launchAgents, "com.example.daily.plist"),
      plist({ label: "com.example.daily", stderr: errPath }),
    );

    const records = discoverLaunchdScheduledTasks({
      dirs: [launchAgents],
      window: singaporeDayWindow("2026-07-27"),
      now: Date.parse("2026-07-28T02:00:00Z"),
      fileTime: () => Date.parse("2026-07-27T03:01:00Z"),
    });

    expect(records[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("stderr log changed"),
      reportPath: errPath,
    });
  });

  it("marks a launchd task successful when only stdout changed in the audited window", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-launchd-discovery-"));
    const launchAgents = join(root, "LaunchAgents");
    const logs = join(root, "logs");
    mkdirSync(launchAgents);
    mkdirSync(logs);
    const outPath = join(logs, "daily.out.log");
    writeFileSync(outPath, "2026-07-27T03:00:00Z OK\n");
    writeFileSync(
      join(launchAgents, "com.example.daily.plist"),
      plist({ label: "com.example.daily", stdout: outPath }),
    );

    const records = discoverLaunchdScheduledTasks({
      dirs: [launchAgents],
      window: singaporeDayWindow("2026-07-27"),
      now: Date.parse("2026-07-28T02:00:00Z"),
      fileTime: () => Date.parse("2026-07-27T03:01:00Z"),
    });

    expect(records[0]).toMatchObject({
      status: "success",
      summary: expect.stringContaining("stdout log changed"),
      reportPath: outPath,
      repairStatus: "not-needed",
    });
  });

  it("uses launchctl last exit code as active evidence when logs are absent", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-launchd-discovery-"));
    const launchAgents = join(root, "LaunchAgents");
    mkdirSync(launchAgents);
    writeFileSync(
      join(launchAgents, "com.example.daily.plist"),
      plist({ label: "com.example.daily", interval: 3600 }),
    );

    const success = discoverLaunchdScheduledTasks({
      dirs: [launchAgents],
      window: singaporeDayWindow("2026-07-27"),
      now: Date.parse("2026-07-28T02:00:00Z"),
      launchctlState: () => "runs = 42\nlast exit code = 0\n",
    });
    const failed = discoverLaunchdScheduledTasks({
      dirs: [launchAgents],
      window: singaporeDayWindow("2026-07-27"),
      now: Date.parse("2026-07-28T02:00:00Z"),
      launchctlState: () => "runs = 42\nlast exit code = 2\n",
    });

    expect(success[0]).toMatchObject({ status: "success", summary: "launchctl last exit code 0" });
    expect(failed[0]).toMatchObject({
      status: "failed",
      error: "launchctl last exit code 2",
    });
  });

  it("keeps a launchd task expected when log evidence is outside the audited window and launchctl has no exit code", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-launchd-discovery-outside-window-"));
    const launchAgents = join(root, "LaunchAgents");
    const logs = join(root, "logs");
    mkdirSync(launchAgents);
    mkdirSync(logs);
    const outPath = join(logs, "daily.out.log");
    const errPath = join(logs, "daily.err.log");
    writeFileSync(outPath, "old success\n");
    writeFileSync(errPath, "old failure\n");
    writeFileSync(
      join(launchAgents, "com.example.daily.plist"),
      plist({ label: "com.example.daily", stdout: outPath, stderr: errPath }),
    );

    const records = discoverLaunchdScheduledTasks({
      dirs: [launchAgents],
      window: singaporeDayWindow("2026-07-27"),
      now: Date.parse("2026-07-28T02:00:00Z"),
      fileTime: (path) =>
        path === outPath || path === errPath ? Date.parse("2026-07-26T03:01:00Z") : null,
      launchctlState: () => "runs = 42\nstate = waiting\n",
    });

    expect(records).toEqual([
      expect.objectContaining({
        taskId: "launchd:com.example.daily:2026-07-27 SGT",
        status: "expected",
        summary: "launchd scheduled task discovered; no explicit task report was recorded",
      }),
    ]);
  });

  it("filters launchd labels and returns discovered records in stable task id order", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-launchd-discovery-"));
    const missingDir = join(root, "MissingLaunchAgents");
    const launchAgents = join(root, "LaunchAgents");
    mkdirSync(launchAgents);
    writeFileSync(join(launchAgents, "README.txt"), "not a plist", "utf8");
    writeFileSync(join(launchAgents, "broken.plist"), "<plist><dict></dict></plist>", "utf8");
    writeFileSync(
      join(launchAgents, "com.example.zeta.plist"),
      plist({ label: "com.example.zeta" }),
    );
    writeFileSync(
      join(launchAgents, "com.example.alpha.plist"),
      plist({ label: "com.example.alpha" }),
    );
    writeFileSync(
      join(launchAgents, "com.example.skip.plist"),
      plist({ label: "com.example.skip" }),
    );

    const records = discoverLaunchdScheduledTasks({
      dirs: [missingDir, launchAgents],
      window: singaporeDayWindow("2026-07-27"),
      now: Date.parse("2026-07-28T02:00:00Z"),
      includeLabel: (label) => label !== "com.example.skip",
    });

    expect(records.map((record) => record.taskId)).toEqual([
      "launchd:com.example.alpha:2026-07-27 SGT",
      "launchd:com.example.zeta:2026-07-27 SGT",
    ]);
  });

  it("does not treat RunAtLoad-only services as scheduled task executions", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-launchd-discovery-"));
    const launchAgents = join(root, "LaunchAgents");
    mkdirSync(launchAgents);
    writeFileSync(
      join(launchAgents, "com.example.service.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.example.service</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
</dict></plist>`,
    );

    expect(
      discoverLaunchdScheduledTasks({
        dirs: [launchAgents],
        window: singaporeDayWindow("2026-07-27"),
        now: Date.parse("2026-07-28T02:00:00Z"),
      }),
    ).toEqual([]);
  });
});

describe("mergeDiscoveredTaskRecords", () => {
  it("keeps explicit ledger records ahead of actively discovered expectations", () => {
    const scheduledAt = Date.parse("2026-07-27T01:00:00Z");
    const ledgerRecord: ScheduledTaskRecord = {
      taskId: "launchd:com.example.daily:2026-07-27 SGT",
      source: "launchd",
      name: "launchd com.example.daily",
      scheduledAt,
      status: "success",
      endedAt: scheduledAt + 1000,
      updatedAt: scheduledAt + 1000,
    };
    const discovered: ScheduledTaskRecord = {
      ...ledgerRecord,
      status: "expected",
      updatedAt: scheduledAt,
    };

    expect(mergeDiscoveredTaskRecords([ledgerRecord], [discovered])).toEqual([ledgerRecord]);
  });

  it("uses completed loop artifacts instead of stale failed loop ledger records", () => {
    const scheduledAt = Date.parse("2026-07-27T01:00:00Z");
    const ledgerRecord: ScheduledTaskRecord = {
      taskId: `loop:geo-backend:bug-fix:${scheduledAt}`,
      source: "loop-engineering",
      name: "geo-backend bug-fix",
      scheduledAt,
      status: "failed",
      error: "supervisor-failed",
      repairStatus: "running",
      updatedAt: scheduledAt + 1000,
    };
    const { error: _error, ...recordWithoutError } = ledgerRecord;
    const discovered: ScheduledTaskRecord = {
      ...recordWithoutError,
      status: "success",
      repairStatus: "not-needed",
      summary: "Supervisor final summary completed.",
      updatedAt: scheduledAt + 2000,
    };

    expect(mergeDiscoveredTaskRecords([ledgerRecord], [discovered])).toEqual([discovered]);
  });

  it("uses later-success resolution instead of stale running loop ledger records", () => {
    const scheduledAt = Date.parse("2026-07-27T01:00:00Z");
    const ledgerRecord: ScheduledTaskRecord = {
      taskId: `loop:geo-backend:bug-fix:${scheduledAt}`,
      source: "loop-engineering",
      name: "geo-backend bug-fix",
      scheduledAt,
      status: "running",
      repairStatus: "running",
      updatedAt: scheduledAt + 1000,
    };
    const discovered: ScheduledTaskRecord = {
      ...ledgerRecord,
      status: "failed",
      error: "loop supervisor final status blocked",
      repairStatus: "fixed",
      summary: "Superseded by later successful loop run.",
      updatedAt: scheduledAt + 2000,
    };

    expect(mergeDiscoveredTaskRecords([ledgerRecord], [discovered])).toEqual([discovered]);
  });

  it("preserves closed loop repair status when discovery sees the same failed artifact again", () => {
    const scheduledAt = Date.parse("2026-07-27T01:00:00Z");
    const ledgerRecord: ScheduledTaskRecord = {
      taskId: `loop:alcove:opportunity-discovery:${scheduledAt}`,
      source: "loop-engineering",
      name: "alcove opportunity-discovery",
      scheduledAt,
      status: "failed",
      error: "loop supervisor final status failed",
      repairStatus: "superseded",
      summary: "Superseded by later successful task loop:alcove:opportunity-discovery:later.",
      updatedAt: scheduledAt + 3000,
    };
    const discovered: ScheduledTaskRecord = {
      ...ledgerRecord,
      repairStatus: "pending",
      summary: "Original failed artifact was rediscovered.",
      updatedAt: scheduledAt + 1000,
    };

    expect(mergeDiscoveredTaskRecords([ledgerRecord], [discovered])).toEqual([
      expect.objectContaining({
        taskId: ledgerRecord.taskId,
        status: "failed",
        repairStatus: "superseded",
        summary: ledgerRecord.summary,
        updatedAt: scheduledAt + 3000,
      }),
    ]);
  });

  it("does not copy closed repair state onto non-repairable discovered loop success", () => {
    const scheduledAt = Date.parse("2026-07-27T01:00:00Z");
    const ledgerRecord: ScheduledTaskRecord = {
      taskId: `loop:geo-backend:bug-fix:${scheduledAt}`,
      source: "loop-engineering",
      name: "geo-backend bug-fix",
      scheduledAt,
      status: "failed",
      repairStatus: "fixed",
      error: "original failure",
      updatedAt: scheduledAt + 1000,
    };
    const discovered: ScheduledTaskRecord = {
      taskId: ledgerRecord.taskId,
      source: "loop-engineering",
      name: "geo-backend bug-fix",
      scheduledAt,
      status: "success",
      repairStatus: "not-needed",
      summary: "Rediscovered final summary completed.",
      updatedAt: scheduledAt + 2000,
    };

    expect(mergeDiscoveredTaskRecords([ledgerRecord], [discovered])).toEqual([discovered]);
  });

  it("uses discovered loop repair evidence when the ledger repair state is still open", () => {
    const scheduledAt = Date.parse("2026-07-27T01:00:00Z");
    const ledgerRecord: ScheduledTaskRecord = {
      taskId: `loop:geo-backend:bug-fix:${scheduledAt}`,
      source: "loop-engineering",
      name: "geo-backend bug-fix",
      scheduledAt,
      status: "failed",
      error: "original failure",
      updatedAt: scheduledAt + 1000,
    };
    const discovered: ScheduledTaskRecord = {
      ...ledgerRecord,
      error: "rediscovered failure",
      repairStatus: "pending",
      summary: "Rediscovered failed artifact.",
      updatedAt: scheduledAt + 2000,
    };

    expect(mergeDiscoveredTaskRecords([ledgerRecord], [discovered])).toEqual([discovered]);
  });

  it("preserves closed loop repair status when reconciling a failed final summary artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-ledger-closed-artifact-"));
    const scheduledAt = Date.parse("2026-07-27T01:00:00Z");
    const runDir = join(root, "loop-runs", "alcove", `${scheduledAt}-alcove-opportunity-discovery`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "failed",
        actionsTaken: ["Original discovery run failed before a later run succeeded."],
      }),
      "utf8",
    );
    const ledgerRecord: ScheduledTaskRecord = {
      taskId: `loop:alcove:opportunity-discovery:${scheduledAt}`,
      source: "loop-engineering",
      name: "alcove opportunity-discovery",
      scheduledAt,
      status: "failed",
      error: "loop supervisor final status failed",
      reportPath: join(runDir, "supervisor.md"),
      repairStatus: "superseded",
      summary: "Superseded by later successful task loop:alcove:opportunity-discovery:later.",
      updatedAt: scheduledAt + 3000,
    };

    expect(mergeDiscoveredTaskRecords([ledgerRecord], [])).toEqual([
      expect.objectContaining({
        taskId: ledgerRecord.taskId,
        status: "failed",
        repairStatus: "superseded",
        summary: ledgerRecord.summary,
        updatedAt: scheduledAt + 3000,
      }),
    ]);
  });

  it("reconciles stale loop ledger failures from supervisor final summaries next to reports", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-ledger-report-artifact-"));
    const scheduledAt = Date.parse("2026-07-27T01:00:00Z");
    const runDir = join(root, "loop-runs", "geo-backend", `${scheduledAt}-geo-backend-bug-fix`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "supervisor.md"), "old failure transcript", "utf8");
    writeFileSync(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "completed",
        actionsTaken: ["Final retry completed and verified."],
      }),
      "utf8",
    );
    const ledgerRecord: ScheduledTaskRecord = {
      taskId: `loop:geo-backend:bug-fix:${scheduledAt}`,
      source: "loop-engineering",
      name: "geo-backend bug-fix",
      scheduledAt,
      status: "failed",
      error: "supervisor-failed",
      reportPath: join(runDir, "supervisor.md"),
      repairStatus: "running",
      updatedAt: scheduledAt + 1000,
    };

    expect(mergeDiscoveredTaskRecords([ledgerRecord], [])).toEqual([
      expect.objectContaining({
        taskId: ledgerRecord.taskId,
        status: "success",
        repairStatus: "not-needed",
        summary: "Final retry completed and verified.",
        reportPath: join(runDir, "supervisor-final-summary.json"),
      }),
    ]);
  });

  it("prefers system-gated supervisor failure over a stale completed final summary", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-ledger-system-gate-artifact-"));
    const scheduledAt = Date.parse("2026-07-27T01:00:00Z");
    const runDir = join(root, "loop-runs", "geo-backend", `${scheduledAt}-geo-backend-bug-fix`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "supervisor.md"), "system gate failed transcript", "utf8");
    writeFileSync(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "completed",
        actionsTaken: ["Opened PR"],
        finalVerification: "passed",
        followUps: [],
      }),
      "utf8",
    );
    writeFileSync(
      join(runDir, "supervisor-summary.json"),
      JSON.stringify({
        status: "supervisor-failed",
        result: { reason: "supervised system gate failed: CI check verify concluded FAILURE" },
        timestamps: { endedAt: scheduledAt + 2000 },
      }),
      "utf8",
    );
    const ledgerRecord: ScheduledTaskRecord = {
      taskId: `loop:geo-backend:bug-fix:${scheduledAt}`,
      source: "loop-engineering",
      name: "geo-backend bug-fix",
      scheduledAt,
      status: "running",
      repairStatus: "running",
      reportPath: join(runDir, "supervisor.md"),
      updatedAt: scheduledAt + 1000,
    };

    expect(mergeDiscoveredTaskRecords([ledgerRecord], [])).toEqual([
      expect.objectContaining({
        taskId: ledgerRecord.taskId,
        status: "failed",
        error:
          "loop supervisor run supervisor-failed: supervised system gate failed: CI check verify concluded FAILURE",
        repairStatus: "pending",
        reportPath: join(runDir, "supervisor.md"),
      }),
    ]);
  });

  it("uses persisted system-gate rejection as final audit evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-ledger-system-gate-json-"));
    const scheduledAt = Date.parse("2026-07-27T01:00:00Z");
    const runDir = join(root, "loop-runs", "geo-backend", `${scheduledAt}-geo-backend-bug-fix`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "completed",
        actionsTaken: ["Opened PR"],
        finalVerification: "passed",
        followUps: [],
      }),
      "utf8",
    );
    writeFileSync(
      join(runDir, "system-gate.json"),
      JSON.stringify({
        accepted: false,
        failures: ["eval outcome is failed: deterministic-gate-failed"],
        evalReport: {
          outcome: {
            status: "failed",
            finalVerification: "passed",
            reviewDecision: "pass",
            reason: "deterministic-gate-failed",
          },
        },
      }),
      "utf8",
    );
    const ledgerRecord: ScheduledTaskRecord = {
      taskId: `loop:geo-backend:bug-fix:${scheduledAt}`,
      source: "loop-engineering",
      name: "geo-backend bug-fix",
      scheduledAt,
      status: "running",
      repairStatus: "running",
      reportPath: join(runDir, "supervisor.md"),
      updatedAt: scheduledAt + 1000,
    };

    expect(mergeDiscoveredTaskRecords([ledgerRecord], [])).toEqual([
      expect.objectContaining({
        taskId: ledgerRecord.taskId,
        status: "failed",
        error: "supervised system gate failed: eval outcome is failed: deterministic-gate-failed",
        summary:
          "System gate rejected a completed supervisor run. eval=failed reason=deterministic-gate-failed",
        repairStatus: "pending",
        reportPath: join(runDir, "system-gate.json"),
      }),
    ]);
  });

  it("uses default system-gate rejection text when no failure details were persisted", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-ledger-system-gate-default-"));
    const scheduledAt = Date.parse("2026-07-27T01:00:00Z");
    const runDir = join(root, "loop-runs", "geo-backend", `${scheduledAt}-geo-backend-bug-fix`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({ status: "completed", actionsTaken: ["Finished before gate rejection."] }),
      "utf8",
    );
    writeFileSync(join(runDir, "system-gate.json"), JSON.stringify({ accepted: false }), "utf8");
    const ledgerRecord: ScheduledTaskRecord = {
      taskId: `loop:geo-backend:bug-fix:${scheduledAt}`,
      source: "loop-engineering",
      name: "geo-backend bug-fix",
      scheduledAt,
      status: "running",
      repairStatus: "running",
      reportPath: join(runDir, "supervisor.md"),
      updatedAt: scheduledAt + 1000,
    };

    expect(mergeDiscoveredTaskRecords([ledgerRecord], [])).toEqual([
      expect.objectContaining({
        status: "failed",
        error: "supervised system gate rejected the run",
        summary: "System gate rejected a completed supervisor run.",
        reportPath: join(runDir, "system-gate.json"),
      }),
    ]);
  });

  it("finds a final summary by replacing a supervisor report filename", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-ledger-report-replace-"));
    const scheduledAt = Date.parse("2026-07-27T01:00:00Z");
    const runDir = join(root, "loop-runs", "geo-backend", `${scheduledAt}-geo-backend-bug-fix`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "custom-supervisor.json"), "old report", "utf8");
    writeFileSync(
      join(runDir, "custom-supervisor-final-summary.json"),
      JSON.stringify({ status: "completed", actionsTaken: ["Recovered through report rewrite."] }),
      "utf8",
    );
    const ledgerRecord: ScheduledTaskRecord = {
      taskId: `loop:geo-backend:bug-fix:${scheduledAt}`,
      source: "loop-engineering",
      name: "geo-backend bug-fix",
      scheduledAt,
      status: "failed",
      reportPath: join(runDir, "custom-supervisor.json"),
      repairStatus: "running",
      updatedAt: scheduledAt + 1000,
    };

    expect(mergeDiscoveredTaskRecords([ledgerRecord], [])).toEqual([
      expect.objectContaining({
        status: "success",
        summary: "Recovered through report rewrite.",
        reportPath: join(runDir, "custom-supervisor-final-summary.json"),
      }),
    ]);
  });

  it("reconciles stale running loop ledger records from the state loop-runs directory", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-ledger-state-artifact-"));
    process.env.TCB_STATE_DIR = root;
    const scheduledAt = Date.parse("2026-07-27T01:00:00Z");
    const runDir = join(root, "loop-runs", "alcove", `${scheduledAt}-alcove-harness-auto`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "completed",
        actionsTaken: ["Harness run completed and merged."],
      }),
      "utf8",
    );
    const ledgerRecord: ScheduledTaskRecord = {
      taskId: `loop:alcove:harness-auto:${scheduledAt}`,
      source: "loop-engineering",
      name: "alcove harness-auto",
      scheduledAt,
      status: "running",
      repairStatus: "running",
      updatedAt: scheduledAt + 1000,
    };

    expect(mergeDiscoveredTaskRecords([ledgerRecord], [])).toEqual([
      expect.objectContaining({
        taskId: ledgerRecord.taskId,
        status: "success",
        repairStatus: "not-needed",
        summary: "Harness run completed and merged.",
      }),
    ]);
  });

  it("closes blocked supervisor final summaries as blocked repair status", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-ledger-blocked-artifact-"));
    const scheduledAt = Date.parse("2026-07-27T01:00:00Z");
    const runDir = join(root, "loop-runs", "tmux-claude-bot", `${scheduledAt}-tmux-claude-bot`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "blocked",
        actionsTaken: ["Stopped because the target worktree was dirty before base sync."],
      }),
      "utf8",
    );
    const ledgerRecord: ScheduledTaskRecord = {
      taskId: `loop:tmux-claude-bot:${scheduledAt}`,
      source: "loop-engineering",
      name: "tmux-claude-bot architecture",
      scheduledAt,
      status: "failed",
      error: "blocked",
      reportPath: join(runDir, "supervisor.md"),
      repairStatus: "running",
      updatedAt: scheduledAt + 1000,
    };

    expect(mergeDiscoveredTaskRecords([ledgerRecord], [])).toEqual([
      expect.objectContaining({
        taskId: ledgerRecord.taskId,
        status: "failed",
        error: "loop supervisor final status blocked",
        repairStatus: "blocked",
        summary: "Stopped because the target worktree was dirty before base sync.",
      }),
    ]);
  });
});

describe("discoverLoopEngineeringScheduledTasks", () => {
  it("returns no loop tasks for missing, blank, or invalid config input", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-discovery-invalid-"));
    const invalidConfigFile = join(root, "invalid.yml");
    writeFileSync(invalidConfigFile, "projects: [", "utf8");
    const window = singaporeDayWindow("2026-07-28");
    const now = Date.parse("2026-07-29T02:00:00Z");

    expect(discoverLoopEngineeringScheduledTasks({ window, now })).toEqual([]);
    expect(discoverLoopEngineeringScheduledTasks({ configFile: "   ", window, now })).toEqual([]);
    expect(
      discoverLoopEngineeringScheduledTasks({ configFile: invalidConfigFile, window, now }),
    ).toEqual([]);
  });

  it("discovers configured loop-engineering schedules as expected tasks", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-discovery-"));
    const configFile = join(root, "loop.yml");
    writeFileSync(
      configFile,
      `
projects:
  - id: geo-backend
    name: Geo Backend
    path: /tmp/geo-backend
    agent: codex
    schedule: "0 2 * * *"
    goal: Improve architecture
    maxRounds: 3
    targetScore: 95
    assessment:
      command: npm run assess
    preflight:
      commands: []
      repair:
        agent: false
    execution:
      agent: true
    eval:
      command: npm run eval
      minScore: 95
    runner:
      kind: agent-supervised
    recovery:
      agent: true
    commit:
      enabled: true
    pullRequest:
      enabled: true
    bugFix:
      enabled: true
      schedule: "30 1 * * *"
      maxRounds: 2
      maxBugsPerRound: 1
    testCoverage:
      enabled: true
      schedule: "45 1 * * *"
      branch: loop/geo-backend/test-coverage
      targetCoverage: 80
      maxRounds: 5
    securityMaintenance:
      enabled: true
      schedule: "15 2 * * *"
      branch: loop/geo-backend/security-maintenance
      maxRounds: 3
    harnessAuto:
      enabled: true
      schedule: "30 2 * * *"
      branch: loop/geo-backend/harness-auto
      maxRounds: 4
    automationGovernanceReview:
      enabled: true
      schedule: "35 2 * * *"
      branch: loop/geo-backend/automation-governance-review
      targetScore: 90
      allowRepairPr: true
    opportunityDiscovery:
      enabled: true
      schedule: "40 2 * * *"
      maxSuggestions: 2
    pullRequestReview:
      enabled: true
      schedule: "0 1 * * *"
      lookbackHours: 36
      consecutivePasses: 2
      autoMerge: false
    allowedActions: []
    blockedActions: []
`,
      "utf8",
    );
    const window = singaporeDayWindow("2026-07-28");
    const records = discoverLoopEngineeringScheduledTasks({
      configFile,
      window,
      now: Date.parse("2026-07-29T02:00:00Z"),
    });

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: `loop:geo-backend:${Date.parse("2026-07-28T02:00:00Z")}`,
          source: "loop-engineering",
          name: "geo-backend architecture",
          status: "expected",
        }),
        expect.objectContaining({
          taskId: `loop:geo-backend:bug-fix:${Date.parse("2026-07-28T01:30:00Z")}`,
          source: "loop-engineering",
          name: "geo-backend bug-fix",
          status: "expected",
        }),
        expect.objectContaining({
          taskId: `loop:geo-backend:test-coverage:${Date.parse("2026-07-28T01:45:00Z")}`,
          source: "loop-engineering",
          name: "geo-backend test-coverage",
          status: "expected",
        }),
        expect.objectContaining({
          taskId: `loop:geo-backend:security-maintenance:${Date.parse("2026-07-28T02:15:00Z")}`,
          source: "loop-engineering",
          name: "geo-backend security-maintenance",
          status: "expected",
        }),
        expect.objectContaining({
          taskId: `loop:geo-backend:harness-auto:${Date.parse("2026-07-28T02:30:00Z")}`,
          source: "loop-engineering",
          name: "geo-backend harness-auto",
          status: "expected",
        }),
        expect.objectContaining({
          taskId: `loop:geo-backend:automation-governance-review:${Date.parse("2026-07-28T02:35:00Z")}`,
          source: "loop-engineering",
          name: "geo-backend automation-governance-review",
          status: "expected",
        }),
        expect.objectContaining({
          taskId: `loop:geo-backend:opportunity-discovery:${Date.parse("2026-07-28T02:40:00Z")}`,
          source: "loop-engineering",
          name: "geo-backend opportunity-discovery",
          status: "expected",
        }),
        expect.objectContaining({
          taskId: `loop:geo-backend:pull-request-review:${Date.parse("2026-07-28T01:00:00Z")}`,
          source: "loop-engineering",
          name: "geo-backend pull-request-review",
          status: "expected",
        }),
      ]),
    );
  });

  it("discovers repository-wide pull request review schedules as expected tasks", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-discovery-repo-prs-"));
    const configFile = join(root, "loop.yml");
    writeFileSync(
      configFile,
      `
projects:
  - id: placeholder
    name: Placeholder
    path: /tmp/placeholder
    agent: codex
    goal: Keep config valid
    maxRounds: 1
    targetScore: 95
    assessment:
      command: "true"
    allowedActions: []
    blockedActions: []
prReview:
  repositories:
    - id: mesh-talk-all-prs
      name: mesh-talk all PRs
      path: /tmp/mesh-talk
      repo: OctopusGarage/mesh-talk
      agent: codex
      schedule: "45 3 * * *"
      switchBack: dev
      autoMerge: true
`,
      "utf8",
    );

    const records = discoverLoopEngineeringScheduledTasks({
      configFile,
      window: singaporeDayWindow("2026-07-28"),
      now: Date.parse("2026-07-29T02:00:00Z"),
    });

    expect(records).toEqual([
      expect.objectContaining({
        taskId: `loop:pr-review:mesh-talk-all-prs:${Date.parse("2026-07-28T03:45:00Z")}`,
        source: "loop-engineering",
        name: "mesh-talk-all-prs repository-pull-request-review",
        status: "expected",
      }),
    ]);
  });

  it("discovers workspace schedules as expected tasks", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-discovery-workspace-"));
    const configFile = join(root, "loop.yml");
    writeFileSync(
      configFile,
      `
workspaces:
  - id: geo
    name: Geo Workspace
    root: /tmp/realestate
    agent: codex
    repositories:
      - id: geo-backend
        name: Geo Backend
        path: /tmp/realestate/geo-backend
        role: backend
        pullRequest:
          enabled: true
      - id: geo-frontend
        name: Geo Frontend
        path: /tmp/realestate/geo-frontend
        role: frontend
        pullRequest:
          enabled: true
    architecture:
      enabled: true
      schedule: "15 4 * * *"
      goal: Improve frontend/backend architecture together.
    bugFix:
      enabled: true
      schedule: "20 4 * * *"
    testCoverage:
      enabled: true
      schedule: "25 4 * * *"
    securityMaintenance:
      enabled: true
      schedule: "30 4 * * *"
    harnessAuto:
      enabled: true
      schedule: "35 4 * * *"
    opportunityDiscovery:
      enabled: true
      schedule: "40 4 * * *"
    pullRequestReview:
      enabled: true
      schedule: "45 4 * * *"
`,
      "utf8",
    );

    const records = discoverLoopEngineeringScheduledTasks({
      configFile,
      window: singaporeDayWindow("2026-07-28"),
      now: Date.parse("2026-07-29T02:00:00Z"),
    });

    expect(records).toEqual([
      expect.objectContaining({
        taskId: `loop:workspace:geo:architecture:${Date.parse("2026-07-28T04:15:00Z")}`,
        source: "loop-engineering",
        name: "geo workspace-architecture",
        status: "expected",
      }),
      expect.objectContaining({
        taskId: `loop:workspace:geo:bug-fix:${Date.parse("2026-07-28T04:20:00Z")}`,
        source: "loop-engineering",
        name: "geo bug-fix",
        status: "expected",
      }),
      expect.objectContaining({
        taskId: `loop:workspace:geo:test-coverage:${Date.parse("2026-07-28T04:25:00Z")}`,
        source: "loop-engineering",
        name: "geo test-coverage",
        status: "expected",
      }),
      expect.objectContaining({
        taskId: `loop:workspace:geo:security-maintenance:${Date.parse("2026-07-28T04:30:00Z")}`,
        source: "loop-engineering",
        name: "geo security-maintenance",
        status: "expected",
      }),
      expect.objectContaining({
        taskId: `loop:workspace:geo:harness-auto:${Date.parse("2026-07-28T04:35:00Z")}`,
        source: "loop-engineering",
        name: "geo harness-auto",
        status: "expected",
      }),
      expect.objectContaining({
        taskId: `loop:workspace:geo:opportunity-discovery:${Date.parse("2026-07-28T04:40:00Z")}`,
        source: "loop-engineering",
        name: "geo opportunity-discovery",
        status: "expected",
      }),
      expect.objectContaining({
        taskId: `loop:workspace:geo:pull-request-review:${Date.parse("2026-07-28T04:45:00Z")}`,
        source: "loop-engineering",
        name: "geo pull-request-review",
        status: "expected",
      }),
    ]);
  });

  it("discovers completed harness-auto run artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-discovery-harness-artifact-"));
    const configFile = join(root, "loop.yml");
    const loopRunsDir = join(root, "loop-runs");
    const scheduledAt = Date.parse("2026-07-28T02:30:00Z");
    const runId = `${scheduledAt}-geo-backend-harness-auto`;
    mkdirSync(join(loopRunsDir, "geo-backend", runId), { recursive: true });
    writeFileSync(
      join(loopRunsDir, "geo-backend", runId, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "completed",
        actionsTaken: ["Harness-auto stopped after health score reached 96."],
      }),
      "utf8",
    );
    writeFileSync(
      configFile,
      `
projects:
  - id: geo-backend
    name: Geo Backend
    path: /tmp/geo-backend
    agent: codex
    goal: Improve architecture
    maxRounds: 3
    targetScore: 95
    assessment:
      command: "true"
    runner:
      kind: agent-supervised
    harnessAuto:
      enabled: true
      schedule: "30 2 * * *"
`,
      "utf8",
    );

    const records = discoverLoopEngineeringScheduledTasks({
      configFile,
      loopRunsDir,
      window: singaporeDayWindow("2026-07-28"),
      now: Date.parse("2026-07-29T02:00:00Z"),
    });

    expect(records).toEqual([
      expect.objectContaining({
        taskId: `loop:geo-backend:harness-auto:${scheduledAt}`,
        source: "loop-engineering",
        name: "geo-backend harness-auto",
        status: "success",
        summary: "Harness-auto stopped after health score reached 96.",
      }),
    ]);
  });

  it("discovers completed workspace non-architecture run artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-discovery-workspace-artifact-"));
    const configFile = join(root, "loop.yml");
    const loopRunsDir = join(root, "loop-runs");
    const scheduledAt = Date.parse("2026-07-28T04:20:00Z");
    const runId = `${scheduledAt}-geo-workspace-bug-fix`;
    mkdirSync(join(loopRunsDir, "geo", runId), { recursive: true });
    writeFileSync(
      join(loopRunsDir, "geo", runId, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "completed",
        actionsTaken: ["Fixed confirmed workspace contract bug."],
      }),
      "utf8",
    );
    writeFileSync(
      configFile,
      `
workspaces:
  - id: geo
    name: Geo Workspace
    root: /tmp/realestate
    agent: codex
    repositories:
      - id: geo-backend
        name: Geo Backend
        path: /tmp/realestate/geo-backend
        role: backend
      - id: geo-frontend
        name: Geo Frontend
        path: /tmp/realestate/geo-frontend
        role: frontend
    architecture:
      enabled: false
      goal: Improve frontend/backend architecture together.
    bugFix:
      enabled: true
      schedule: "20 4 * * *"
`,
      "utf8",
    );

    const records = discoverLoopEngineeringScheduledTasks({
      configFile,
      loopRunsDir,
      window: singaporeDayWindow("2026-07-28"),
      now: Date.parse("2026-07-29T02:00:00Z"),
    });

    expect(records).toEqual([
      expect.objectContaining({
        taskId: `loop:workspace:geo:bug-fix:${scheduledAt}`,
        source: "loop-engineering",
        name: "geo bug-fix",
        status: "success",
        summary: "Fixed confirmed workspace contract bug.",
      }),
    ]);
  });

  it("does not report a jitter-delayed loop job before its effective audit window", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-discovery-jitter-"));
    const configFile = join(root, "loop.yml");
    writeFileSync(
      configFile,
      `
scheduler:
  jitter:
    enabled: true
    architectureMaxDelayMinutes: 240
projects:
  - id: late
    name: Late
    path: /tmp/late
    agent: codex
    schedule: "59 15 * * *"
    goal: Improve architecture
    maxRounds: 1
    targetScore: 95
    assessment:
      command: "true"
    allowedActions: []
    blockedActions: []
`,
      "utf8",
    );

    const records = discoverLoopEngineeringScheduledTasks({
      configFile,
      window: singaporeDayWindow("2026-07-29"),
      now: Date.parse("2026-07-28T16:30:00Z"),
    });

    expect(records).toEqual([]);
  });

  it("reports a loop job whose jitter-delayed effective time enters the audit window", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-discovery-jitter-in-window-"));
    const configFile = join(root, "loop.yml");
    writeFileSync(
      configFile,
      `
scheduler:
  jitter:
    enabled: true
    architectureMaxDelayMinutes: 240
projects:
  - id: late
    name: Late
    path: /tmp/late
    agent: codex
    schedule: "59 15 * * *"
    goal: Improve architecture
    maxRounds: 1
    targetScore: 95
    assessment:
      command: "true"
    allowedActions: []
    blockedActions: []
`,
      "utf8",
    );
    const scheduledAt = Date.parse("2026-07-27T15:59:00Z");

    const records = discoverLoopEngineeringScheduledTasks({
      configFile,
      window: singaporeDayWindow("2026-07-28"),
      now: Date.parse("2026-07-27T20:00:00Z"),
    });

    expect(records).toEqual([
      expect.objectContaining({
        taskId: `loop:late:${scheduledAt}`,
        scheduledAt,
        status: "expected",
      }),
    ]);
  });

  it("reconciles configured loop-engineering schedules with existing supervisor reports", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-discovery-reports-"));
    const configFile = join(root, "loop.yml");
    const loopRunsDir = join(root, "loop-runs");
    writeFileSync(
      configFile,
      `
projects:
  - id: geo-backend
    name: Geo Backend
    path: /tmp/geo-backend
    agent: codex
    schedule: "0 2 * * *"
    goal: Improve architecture
    maxRounds: 3
    targetScore: 95
    assessment:
      command: npm run assess
    preflight:
      commands: []
      repair:
        agent: false
    execution:
      agent: true
    eval:
      command: npm run eval
      minScore: 95
    runner:
      kind: agent-supervised
    recovery:
      agent: true
    commit:
      enabled: true
    pullRequest:
      enabled: true
    pullRequestReview:
      enabled: false
    allowedActions: []
    blockedActions: []
`,
      "utf8",
    );
    const scheduledAt = Date.parse("2026-07-28T02:00:00Z");
    const runDir = join(loopRunsDir, "geo-backend", `${scheduledAt}-geo-backend`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "supervisor.md"), "# Loop Supervisor Report\n", "utf8");
    writeFileSync(
      join(runDir, "supervisor-summary.json"),
      JSON.stringify(
        {
          workOrderId: `${scheduledAt}-geo-backend`,
          runId: `${scheduledAt}-geo-backend`,
          status: "invalid-output",
          timestamps: {
            scheduledAt,
            startedAt: scheduledAt + 1000,
            endedAt: scheduledAt + 2000,
          },
          result: {
            status: "invalid-output",
            reason: "missing-final-marker",
            output: "missing final marker",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const records = discoverLoopEngineeringScheduledTasks({
      configFile,
      loopRunsDir,
      window: singaporeDayWindow("2026-07-28"),
      now: Date.parse("2026-07-29T02:00:00Z"),
    });

    expect(records).toEqual([
      expect.objectContaining({
        taskId: `loop:geo-backend:${scheduledAt}`,
        source: "loop-engineering",
        status: "failed",
        error: "loop supervisor run invalid-output: missing-final-marker",
        reportPath: join(runDir, "supervisor.md"),
      }),
    ]);
  });

  it("prefers a parseable final supervisor summary over a stale invalid report", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-discovery-final-"));
    const configFile = join(root, "loop.yml");
    const loopRunsDir = join(root, "loop-runs");
    writeFileSync(
      configFile,
      `
projects:
  - id: knowledge-engine
    name: Knowledge Engine
    path: /tmp/knowledge-engine
    agent: codex
    schedule: "0 3 * * *"
    goal: Improve architecture
    maxRounds: 3
    targetScore: 95
    assessment:
      command: npm run assess
    preflight:
      commands: []
      repair:
        agent: false
    execution:
      agent: true
    eval:
      command: npm run eval
      minScore: 95
    runner:
      kind: agent-supervised
    recovery:
      agent: true
    commit:
      enabled: true
    pullRequest:
      enabled: true
    pullRequestReview:
      enabled: false
    allowedActions: []
    blockedActions: []
`,
      "utf8",
    );
    const scheduledAt = Date.parse("2026-07-28T03:00:00Z");
    const runDir = join(loopRunsDir, "knowledge-engine", `${scheduledAt}-knowledge-engine`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "supervisor-summary.json"),
      JSON.stringify({ status: "invalid-output", result: { reason: "invalid-summary" } }),
      "utf8",
    );
    writeFileSync(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "completed",
        projectId: "knowledge-engine",
        actionsTaken: ["Opened PR"],
        delegatedTasks: [],
        finalVerification: "passed",
        commits: ["abc1234"],
        followUps: [],
      }),
      "utf8",
    );

    const records = discoverLoopEngineeringScheduledTasks({
      configFile,
      loopRunsDir,
      window: singaporeDayWindow("2026-07-28"),
      now: Date.parse("2026-07-29T02:00:00Z"),
    });

    expect(records).toEqual([
      expect.objectContaining({
        taskId: `loop:knowledge-engine:${scheduledAt}`,
        source: "loop-engineering",
        status: "success",
        summary: "Opened PR",
        reportPath: join(runDir, "supervisor-final-summary.json"),
      }),
    ]);
  });

  it("marks failed loop runs as fixed when a later same-kind run completed", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-discovery-later-success-"));
    const configFile = join(root, "loop.yml");
    const loopRunsDir = join(root, "loop-runs");
    writeFileSync(
      configFile,
      `
projects:
  - id: geo-backend
    name: Geo Backend
    path: /tmp/geo-backend
    agent: codex
    schedule: "0 2 * * *"
    goal: Improve architecture
    maxRounds: 3
    targetScore: 95
    assessment:
      command: npm run assess
    preflight:
      commands: []
      repair:
        agent: false
    execution:
      agent: true
    eval:
      command: npm run eval
      minScore: 95
    runner:
      kind: agent-supervised
    recovery:
      agent: true
    commit:
      enabled: true
    pullRequest:
      enabled: true
    pullRequestReview:
      enabled: false
    allowedActions: []
    blockedActions: []
`,
      "utf8",
    );
    const failedAt = Date.parse("2026-07-28T02:00:00Z");
    const fixedAt = Date.parse("2026-07-28T05:00:00Z");
    const failedDir = join(loopRunsDir, "geo-backend", `${failedAt}-geo-backend`);
    const fixedDir = join(loopRunsDir, "geo-backend", `${fixedAt}-geo-backend`);
    mkdirSync(failedDir, { recursive: true });
    mkdirSync(fixedDir, { recursive: true });
    writeFileSync(
      join(failedDir, "supervisor-summary.json"),
      JSON.stringify({ status: "invalid-output", result: { reason: "missing-final-marker" } }),
      "utf8",
    );
    writeFileSync(
      join(fixedDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "completed",
        projectId: "geo-backend",
        actionsTaken: ["Score reached 95"],
        delegatedTasks: [],
        finalVerification: "passed",
        commits: [],
        followUps: [],
      }),
      "utf8",
    );

    const records = discoverLoopEngineeringScheduledTasks({
      configFile,
      loopRunsDir,
      window: singaporeDayWindow("2026-07-28"),
      now: Date.parse("2026-07-28T06:00:00Z"),
    });

    expect(records[0]).toMatchObject({
      taskId: `loop:geo-backend:${failedAt}`,
      status: "failed",
      repairStatus: "fixed",
      summary: expect.stringContaining("Superseded by later successful loop run"),
    });
  });

  it("flags completed loop final summaries whose final verification did not pass", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-discovery-completed-anomaly-"));
    const configFile = join(root, "loop.yml");
    const loopRunsDir = join(root, "loop-runs");
    writeFileSync(
      configFile,
      `
projects:
  - id: hub
    name: Hub
    path: /tmp/hub
    agent: codex
    schedule: "0 2 * * *"
    goal: Improve architecture
    maxRounds: 1
    targetScore: 95
    assessment:
      command: npm run assess
    execution:
      agent: true
    allowedActions: []
    blockedActions: []
`,
      "utf8",
    );
    const scheduledAt = Date.parse("2026-07-28T02:00:00Z");
    const runDir = join(loopRunsDir, "hub", `${scheduledAt}-hub`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "completed",
        projectId: "hub",
        actionsTaken: ["Stopped early"],
        delegatedTasks: [],
        finalVerification: "not-run",
        commits: [],
        followUps: [],
      }),
      "utf8",
    );

    const records = discoverLoopEngineeringScheduledTasks({
      configFile,
      loopRunsDir,
      window: singaporeDayWindow("2026-07-28"),
      now: Date.parse("2026-07-29T02:00:00Z"),
    });

    expect(records[0]).toMatchObject({
      taskId: `loop:hub:${scheduledAt}`,
      status: "failed",
      error: "loop supervisor completed with finalVerification=not-run",
      repairStatus: "pending",
    });
  });

  it("does not flag completed loop final summaries for harmless follow-up notes", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-discovery-harmless-followup-"));
    const configFile = join(root, "loop.yml");
    const loopRunsDir = join(root, "loop-runs");
    writeFileSync(
      configFile,
      `
projects:
  - id: hub
    name: Hub
    path: /tmp/hub
    agent: codex
    schedule: "0 2 * * *"
    goal: Improve architecture
    maxRounds: 1
    targetScore: 95
    assessment:
      command: npm run assess
    execution:
      agent: true
    allowedActions: []
    blockedActions: []
`,
      "utf8",
    );
    const scheduledAt = Date.parse("2026-07-28T02:00:00Z");
    const runDir = join(loopRunsDir, "hub", `${scheduledAt}-hub`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "completed",
        projectId: "hub",
        actionsTaken: ["Score reached 95"],
        delegatedTasks: [],
        finalVerification: "passed",
        commits: [],
        followUps: ["Review supervisor logs weekly"],
      }),
      "utf8",
    );

    const records = discoverLoopEngineeringScheduledTasks({
      configFile,
      loopRunsDir,
      window: singaporeDayWindow("2026-07-28"),
      now: Date.parse("2026-07-29T02:00:00Z"),
    });

    expect(records[0]).toMatchObject({
      taskId: `loop:hub:${scheduledAt}`,
      status: "success",
      repairStatus: "not-needed",
    });
  });

  it("flags completed loop final summaries with risky unresolved follow-ups", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-discovery-risky-followup-"));
    const configFile = join(root, "loop.yml");
    const loopRunsDir = join(root, "loop-runs");
    writeFileSync(
      configFile,
      `
projects:
  - id: hub
    name: Hub
    path: /tmp/hub
    agent: codex
    schedule: "0 2 * * *"
    goal: Improve architecture
    maxRounds: 1
    targetScore: 95
    assessment:
      command: npm run assess
    execution:
      agent: true
    allowedActions: []
    blockedActions: []
`,
      "utf8",
    );
    const scheduledAt = Date.parse("2026-07-28T02:00:00Z");
    const runDir = join(loopRunsDir, "hub", `${scheduledAt}-hub`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "supervisor-final-summary.json"),
      JSON.stringify({
        status: "completed",
        projectId: "hub",
        actionsTaken: [],
        delegatedTasks: [],
        finalVerification: "passed",
        commits: [],
        followUps: ["CI was not verified before stopping"],
      }),
      "utf8",
    );

    const records = discoverLoopEngineeringScheduledTasks({
      configFile,
      loopRunsDir,
      window: singaporeDayWindow("2026-07-28"),
      now: Date.parse("2026-07-29T02:00:00Z"),
    });

    expect(records[0]).toMatchObject({
      taskId: `loop:hub:${scheduledAt}`,
      status: "failed",
      error:
        "loop supervisor completed with unresolved risky follow-up: CI was not verified before stopping",
      summary: "final summary status completed",
      repairStatus: "pending",
    });
  });

  it("uses supervisor summary success when the final summary artifact is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-loop-discovery-supervisor-success-"));
    const configFile = join(root, "loop.yml");
    const loopRunsDir = join(root, "loop-runs");
    writeFileSync(
      configFile,
      `
projects:
  - id: hub
    name: Hub
    path: /tmp/hub
    agent: codex
    schedule: "0 2 * * *"
    goal: Improve architecture
    maxRounds: 1
    targetScore: 95
    assessment:
      command: npm run assess
    execution:
      agent: true
    allowedActions: []
    blockedActions: []
`,
      "utf8",
    );
    const scheduledAt = Date.parse("2026-07-28T02:00:00Z");
    const runDir = join(loopRunsDir, "hub", `${scheduledAt}-hub`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "supervisor-summary.json"),
      JSON.stringify({ status: "completed", timestamps: { endedAt: scheduledAt + 2000 } }),
      "utf8",
    );

    const records = discoverLoopEngineeringScheduledTasks({
      configFile,
      loopRunsDir,
      window: singaporeDayWindow("2026-07-28"),
      now: Date.parse("2026-07-29T02:00:00Z"),
    });

    expect(records[0]).toMatchObject({
      taskId: `loop:hub:${scheduledAt}`,
      status: "success",
      endedAt: scheduledAt + 2000,
      summary: "Loop supervisor run completed.",
      reportPath: join(runDir, "supervisor-summary.json"),
      repairStatus: "not-needed",
    });
  });

  it("ignores missing or invalid loop-engineering configs", () => {
    const window = singaporeDayWindow("2026-07-28");
    const records = discoverLoopEngineeringScheduledTasks({
      configFile: "/tmp/does-not-exist.yml",
      window,
      now: Date.parse("2026-07-29T02:00:00Z"),
    });

    expect(records).toEqual([]);
  });
});
