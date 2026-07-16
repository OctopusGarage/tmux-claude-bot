import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createLogger } from "../../shared/utils/logger.js";
import type { HandlerDeps } from "../deps.js";
import {
  createLoopQueueAgentEvalRunner,
  createLoopQueueAgentTaskRunner,
  createLoopSupervisorTaskRunner,
  restoreLoopControlQueue,
} from "./agent-queue.js";
import { LoopBacklogStore } from "./backlog.js";
import { parseLoopConfigYaml } from "./config.js";
import { writeLoopRunReport } from "./report.js";
import {
  type LoopGitInvocation,
  type LoopRunCommandInvocation,
  type LoopRunCommandResult,
  type LoopRunSummary,
  runLoopProject,
  runLoopProjectAsync,
} from "./run.js";
import { LoopSchedulerStore, runLoopSchedulerTick } from "./scheduler.js";
import {
  type LoopSupervisedRunResult,
  runLoopSupervisedProjectAsync,
} from "./supervised-runner.js";
import { completeLoopSupervisorRun } from "./supervisor-completion.js";
import { loopSupervisorSessionName } from "./supervisor-session.js";
import { buildLoopWorkOrder } from "./work-order.js";

const log = createLogger("loop.service");
const DEFAULT_LOOP_SUPERVISOR_TIMEOUT_MS = 7_200_000;

export type LoopServiceTickSummary = {
  checked: number;
  due: number;
  ran: number;
  failed: number;
};

function logSchedulerTick(input: {
  configFile: string;
  now: number;
  scheduler: ReturnType<typeof runLoopSchedulerTick>;
}): void {
  log.info("loop engineering scheduler tick", {
    data: {
      configFile: input.configFile,
      now: new Date(input.now).toISOString(),
      checked: input.scheduler.checked,
      scheduled: input.scheduler.scheduled,
      due: input.scheduler.due,
      skipped: input.scheduler.skipped,
      dueProjects: input.scheduler.dueProjects.map((project) => ({
        projectId: project.projectId,
        name: project.name,
        scheduledAt: new Date(project.scheduledAt).toISOString(),
      })),
    },
  });
}

function logRunResult(input: {
  runId: string;
  scheduledAt: number;
  startedAt: number;
  endedAt: number;
  summary: LoopRunSummary;
  report: ReturnType<typeof writeLoopRunReport>;
}): void {
  const failedCommands = input.summary.commands
    .filter((command) => command.status !== 0)
    .map((command) => ({
      kind: command.kind,
      command: command.command,
      status: command.status,
      stderr: command.stderr.slice(0, 500),
      stdout: command.stdout.slice(0, 500),
    }));
  log[input.summary.status === "passed" ? "info" : "warn"](
    "loop engineering project run complete",
    {
      data: {
        runId: input.runId,
        projectId: input.summary.projectId,
        projectName: input.summary.projectName,
        status: input.summary.status,
        committed: input.summary.committed,
        scheduledAt: new Date(input.scheduledAt).toISOString(),
        startedAt: new Date(input.startedAt).toISOString(),
        endedAt: new Date(input.endedAt).toISOString(),
        durationMs: input.endedAt - input.startedAt,
        rounds: input.summary.rounds.map((round) => ({
          findingId: round.findingId,
          title: round.title,
          status: round.status,
          reason: round.reason,
          commitSha: round.commitSha,
        })),
        failedCommands,
        reportPath: input.report.markdownPath,
        summaryPath: input.report.summaryPath,
      },
    },
  );
}

function logSupervisorRunResult(input: {
  runId: string;
  scheduledAt: number;
  startedAt: number;
  endedAt: number;
  projectId: string;
  projectName: string;
  result: LoopSupervisedRunResult;
  report: ReturnType<typeof completeLoopSupervisorRun>["report"];
}): void {
  log[input.result.status === "completed" ? "info" : "warn"](
    "loop engineering supervised project run complete",
    {
      data: {
        runId: input.runId,
        projectId: input.projectId,
        projectName: input.projectName,
        status: input.result.status,
        scheduledAt: new Date(input.scheduledAt).toISOString(),
        startedAt: new Date(input.startedAt).toISOString(),
        endedAt: new Date(input.endedAt).toISOString(),
        durationMs: input.endedAt - input.startedAt,
        reportPath: input.report.markdownPath,
        summaryPath: input.report.summaryPath,
      },
    },
  );
}

export function runLoopServiceTick(input: {
  configFile: string;
  now: number;
  schedulerStore: LoopSchedulerStore;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
}): LoopServiceTickSummary {
  const config = parseLoopConfigYaml(readFileSync(input.configFile, "utf8"));
  const scheduler = runLoopSchedulerTick({
    config,
    now: input.now,
    lastFired: input.schedulerStore.getLastFired(),
    setLastFired: (projectId, firedAt) => input.schedulerStore.setLastFired(projectId, firedAt),
  });
  logSchedulerTick({ configFile: input.configFile, now: input.now, scheduler });
  let ran = 0;
  let failed = 0;
  const backlog = new LoopBacklogStore();

  for (const due of scheduler.dueProjects) {
    log.info("loop engineering project run start", {
      data: {
        projectId: due.projectId,
        projectName: due.name,
        scheduledAt: new Date(due.scheduledAt).toISOString(),
      },
    });
    const startedAt = Date.now();
    const summary = runLoopProject({
      config,
      projectId: due.projectId,
      runCommand: input.runCommand,
    });
    const endedAt = Date.now();
    const runId = `${due.scheduledAt}-${due.projectId}`;
    const report = writeLoopRunReport(summary, {
      startedAt,
      endedAt,
      runId,
    });
    backlog.addSuggestions(summary, endedAt, report.runId);
    logRunResult({ runId, scheduledAt: due.scheduledAt, startedAt, endedAt, summary, report });
    ran++;
    if (summary.status === "failed") failed++;
  }

  return {
    checked: scheduler.checked,
    due: scheduler.due,
    ran,
    failed,
  };
}

export async function runLoopServiceTickAsync(input: {
  configFile: string;
  now: number;
  schedulerStore: LoopSchedulerStore;
  runCommand: (invocation: LoopRunCommandInvocation) => LoopRunCommandResult;
  runAgentTask?: Parameters<typeof runLoopProjectAsync>[0]["runAgentTask"];
  runAgentEval?: Parameters<typeof runLoopProjectAsync>[0]["runAgentEval"];
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  runSupervisorTask?: Parameters<typeof runLoopSupervisedProjectAsync>[0]["dispatch"];
  supervisorSessionName?: string;
  defaultSupervisorTimeoutMs?: number;
}): Promise<LoopServiceTickSummary> {
  const config = parseLoopConfigYaml(readFileSync(input.configFile, "utf8"));
  const previousLastFired = input.schedulerStore.getLastFired();
  const scheduler = runLoopSchedulerTick({
    config,
    now: input.now,
    lastFired: previousLastFired,
    setLastFired: (projectId, firedAt) => input.schedulerStore.setLastFired(projectId, firedAt),
  });
  logSchedulerTick({ configFile: input.configFile, now: input.now, scheduler });
  let ran = 0;
  let failed = 0;
  const backlog = new LoopBacklogStore();

  for (const due of scheduler.dueProjects) {
    const project = config.projects.find((candidate) => candidate.id === due.projectId);
    if (project === undefined) {
      throw new Error(`loop scheduler produced unknown project "${due.projectId}"`);
    }
    log.info("loop engineering project run start", {
      data: {
        projectId: due.projectId,
        projectName: due.name,
        scheduledAt: new Date(due.scheduledAt).toISOString(),
      },
    });
    const startedAt = Date.now();
    const runId = `${due.scheduledAt}-${due.projectId}`;
    if (project.runner.kind === "agent-supervised") {
      const workOrder = buildLoopWorkOrder({
        config,
        project,
        scheduledAt: due.scheduledAt,
        runId,
      });
      const supervisorSession = input.supervisorSessionName;
      let result: LoopSupervisedRunResult;
      if (supervisorSession === undefined) {
        result = {
          status: "dispatch-failed",
          reason: "missing loop supervisor session name",
          output: "missing loop supervisor session name",
        };
      } else if (input.runSupervisorTask === undefined) {
        result = {
          status: "dispatch-failed",
          reason: "missing loop supervisor dispatch adapter",
          output: "missing loop supervisor dispatch adapter",
        };
      } else {
        result = await runLoopSupervisedProjectAsync({
          workOrder,
          supervisorSession,
          timeoutMs:
            project.runner.timeoutMs ??
            input.defaultSupervisorTimeoutMs ??
            DEFAULT_LOOP_SUPERVISOR_TIMEOUT_MS,
          dispatch: input.runSupervisorTask,
        });
      }
      const endedAt = Date.now();
      const completion = completeLoopSupervisorRun({
        workOrder,
        supervisorSession: supervisorSession ?? "unconfigured-loop-supervisor",
        startedAt,
        endedAt,
        result,
        backlog,
      });
      if (completion.retrySchedule) {
        restoreLastFired(input.schedulerStore, previousLastFired, project.id, due.scheduledAt);
      }
      logSupervisorRunResult({
        runId,
        scheduledAt: due.scheduledAt,
        startedAt,
        endedAt,
        projectId: project.id,
        projectName: project.name,
        result,
        report: completion.report,
      });
      ran++;
      if (result.status !== "completed") failed++;
      continue;
    }
    const summary = await runLoopProjectAsync({
      config,
      projectId: due.projectId,
      runCommand: input.runCommand,
      ...(input.runAgentTask !== undefined ? { runAgentTask: input.runAgentTask } : {}),
      ...(input.runAgentEval !== undefined ? { runAgentEval: input.runAgentEval } : {}),
      ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
    });
    const endedAt = Date.now();
    const report = writeLoopRunReport(summary, {
      startedAt,
      endedAt,
      runId,
    });
    backlog.addSuggestions(summary, endedAt, report.runId);
    logRunResult({ runId, scheduledAt: due.scheduledAt, startedAt, endedAt, summary, report });
    ran++;
    if (summary.status === "failed") failed++;
  }

  return {
    checked: scheduler.checked,
    due: scheduler.due,
    ran,
    failed,
  };
}

function restoreLastFired(
  store: LoopSchedulerStore,
  previousLastFired: Record<string, number>,
  projectId: string,
  failedScheduledAt: number,
): void {
  const current = store.getLastFired()[projectId];
  if (current !== failedScheduledAt) return;
  const previous = previousLastFired[projectId];
  if (previous === undefined) store.clearLastFired(projectId);
  else store.setLastFired(projectId, previous);
}

export function startLoopEngineering(
  deps: HandlerDeps,
  config: { configFile: string; tickMs: number },
): () => void {
  if (config.configFile.trim() === "" || config.tickMs === 0) return () => {};
  const restored = restoreLoopControlQueue({ queue: deps.queue });
  if (restored > 0) log.info("loop engineering control queue restored", { data: { restored } });
  const schedulerStore = new LoopSchedulerStore();
  let tickInFlight = false;
  const tick = async (): Promise<void> => {
    if (tickInFlight) {
      log.warn("loop engineering tick skipped because previous tick is still running");
      return;
    }
    tickInFlight = true;
    try {
      const result = await runLoopServiceTickAsync({
        configFile: config.configFile,
        now: Date.now(),
        schedulerStore,
        runCommand: runShellCommand,
        runAgentTask: createLoopQueueAgentTaskRunner(deps),
        runAgentEval: createLoopQueueAgentEvalRunner(deps),
        runGit: runGitCommand,
        runSupervisorTask: createLoopSupervisorTaskRunner(deps),
        supervisorSessionName: loopSupervisorSessionName(deps.config.projectSessionPrefix),
        defaultSupervisorTimeoutMs: deps.config.maxWaitDoneTotalMs,
      });
      log.info("loop engineering tick complete", { data: result });
    } catch (err) {
      log.error("loop engineering tick failed", { err });
    } finally {
      tickInFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), config.tickMs);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}

function runShellCommand(invocation: LoopRunCommandInvocation): LoopRunCommandResult {
  const result = spawnSync("sh", ["-lc", invocation.command], {
    cwd: invocation.cwd,
    env: { ...process.env, ...invocation.env },
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error instanceof Error ? result.error.message : ""),
  };
}

function runGitCommand(invocation: LoopGitInvocation): LoopRunCommandResult {
  const result = spawnSync("git", invocation.args, {
    cwd: invocation.cwd,
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error instanceof Error ? result.error.message : ""),
  };
}
