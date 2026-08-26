import { createLogger } from "../../shared/utils/logger.js";
import { startActiveDelegatedTask } from "../autopilot/delegated-task.js";
import type { HandlerDeps } from "../deps.js";
import { sessionNameFromPath, setPathForSession } from "../projects/sessionPathMap.js";
import { cleanupWorkerSessionRecords } from "../recovery/worker-session-cleanup.js";
import {
  type DailyTaskAuditServiceTickResult,
  dispatchDailyTaskRepair,
  runDailyTaskAuditServiceTick,
} from "./daily-audit-service.js";
import {
  createProjectRecoveryDelegator,
  dispatchProjectRecovery,
} from "./project-recovery-dispatch.js";
import { DailyTaskLedger } from "./task-ledger.js";
import { reconcileAutopilotDelegatedTasks } from "./task-reconciliation.js";

const log = createLogger("tasks.system-self-heal");

type TimerHandle = ReturnType<typeof setInterval> | number;

export type SystemSelfHealTickResult =
  | { fired: false; reason: "disabled" | "in-progress" }
  | {
      fired: true;
      audit: DailyTaskAuditServiceTickResult;
      agentSweep?: "disabled" | "queued" | "blocked";
    };

type SystemSelfHealConfig = {
  enabled: boolean;
  tickMs: number;
  agentSweepEnabled: boolean;
};

let systemSelfHealTickInFlight = false;

export async function runSystemSelfHealTick(input: {
  now: number;
  config: SystemSelfHealConfig;
  runAudit: (input: { now: number; force: false }) => Promise<DailyTaskAuditServiceTickResult>;
  runAgentSweep?: () => Promise<"disabled" | "queued" | "blocked">;
}): Promise<SystemSelfHealTickResult> {
  if (!input.config.enabled || input.config.tickMs === 0)
    return { fired: false, reason: "disabled" };
  if (systemSelfHealTickInFlight) return { fired: false, reason: "in-progress" };
  systemSelfHealTickInFlight = true;
  try {
    const audit = await input.runAudit({ now: input.now, force: false });
    const agentSweep =
      input.config.agentSweepEnabled && input.runAgentSweep !== undefined
        ? await input.runAgentSweep()
        : "disabled";
    return { fired: true, audit, agentSweep };
  } finally {
    systemSelfHealTickInFlight = false;
  }
}

export function startSystemSelfHeal(
  deps: HandlerDeps,
  options: {
    now?: () => number;
    setInterval?: (tick: () => void, delayMs: number) => TimerHandle;
    clearInterval?: (timer: TimerHandle) => void;
    runTick?: (input: {
      now: number;
      config: SystemSelfHealConfig;
      runAudit: (input: { now: number; force: false }) => Promise<DailyTaskAuditServiceTickResult>;
      runAgentSweep: () => Promise<"disabled" | "queued" | "blocked">;
    }) => Promise<SystemSelfHealTickResult>;
  } = {},
): () => void {
  const config = deps.config.systemSelfHeal;
  if (!config.enabled || config.tickMs === 0) {
    log.info("system self-heal disabled");
    return () => {};
  }
  const now = options.now ?? Date.now;
  const runTick = options.runTick ?? runSystemSelfHealTick;
  const clearTimer =
    options.clearInterval ??
    ((timer: TimerHandle) => clearInterval(timer as ReturnType<typeof setInterval>));
  const tick = (): void => {
    const tickNow = now();
    void runTick({
      now: tickNow,
      config,
      runAudit: ({ now: auditNow, force }) =>
        runDailyTaskAuditServiceTick({
          now: auditNow,
          config: {
            ...deps.config.taskAudit,
            enabled: true,
            tickMs: Math.max(1, deps.config.taskAudit.tickMs),
          },
          notifications: deps.notifications,
          dispatchRepair: (request) => dispatchDailyTaskRepair(deps, request),
          dispatchProjectRecovery: (request) =>
            dispatchProjectRecovery(request, {
              projectSessionPrefix: deps.config.projectSessionPrefix,
              worktreeIsolation:
                deps.config.loopEngineering.supervisor.worktreeIsolation === "source"
                  ? "source"
                  : "isolated",
              delegate: createProjectRecoveryDelegator(deps),
            }),
          loopConfigFile: deps.config.loopEngineering.configFile,
          reconcile: async () => {
            await reconcileAutopilotDelegatedTasks({
              cleanupWorkerSession: async (session) => {
                await deps.bridge.killSession(session);
                cleanupWorkerSessionRecords(session);
              },
            });
          },
          skipScheduledAudit: true,
          force,
        }),
      runAgentSweep: () => dispatchAgentSelfHealSweep(deps, tickNow),
    }).catch((err) => log.warn("system self-heal tick failed", { err }));
  };
  const timer = (options.setInterval ?? setInterval)(tick, config.tickMs);
  (timer as { unref?: () => void }).unref?.();
  void tick();
  log.info("system self-heal started", { data: { tickMs: config.tickMs } });
  return () => clearTimer(timer);
}

async function dispatchAgentSelfHealSweep(
  deps: HandlerDeps,
  now = Date.now(),
): Promise<"disabled" | "queued" | "blocked"> {
  if (!deps.config.systemSelfHeal.agentSweepEnabled) return "disabled";
  const repoPath = deps.config.taskAudit.repoPath.trim() || process.cwd();
  const session = sessionNameFromPath(repoPath, deps.config.projectSessionPrefix);
  setPathForSession(session, repoPath);
  const result = await startActiveDelegatedTask(deps, {
    session,
    requirement: buildAgentSelfHealRequirement(),
    worktreeIsolation: deps.config.taskAudit.repairWorktreeIsolation,
    resourceTrigger: "background",
    resourceForce: false,
  });
  if (result.status === "blocked") {
    recordBlockedAgentSweep(now, result.reason);
    log.info("system self-heal agent sweep deferred", { data: { reason: result.reason } });
    return "blocked";
  }
  log.info("system self-heal agent sweep queued", {
    data: { runId: result.runId, supervisorSession: result.supervisorSession },
  });
  return "queued";
}

function recordBlockedAgentSweep(now: number, reason: string): void {
  const ledger = new DailyTaskLedger();
  const taskId = `system-self-heal:agent-sweep:${now}`;
  ledger.expect({
    taskId,
    source: "system-self-heal",
    name: "tmux-claude-bot system self-heal agent sweep",
    scheduledAt: now,
    summary: "System self-heal attempted to queue the broad active-agent sweep.",
  });
  ledger.start(taskId, now);
  ledger.skip(taskId, {
    endedAt: now,
    summary: `System self-heal agent sweep deferred before WorkOrder creation: ${reason}`,
  });
}

function buildAgentSelfHealRequirement(): string {
  return [
    "Run an operator-equivalent investigation: check whether every tmux-claude-bot automation task from the last 24 hours is healthy, and fix everything that is safe to fix without waiting for another manual prompt.",
    "Do not narrow the investigation to a fixed checklist. Use any relevant local evidence needed to reach the same practical outcome as an operator asking in chat: task ledger state, Repair Coordinator queues, Loop Supervisor WorkOrders, active worker leases, Runtime Guardian findings, Resource Guardian/admission state, Agent Capacity state, service logs, git state, open PR/CI state when relevant, notification output, maintained docs/config drift, and source code.",
    "For every abnormality, also investigate why existing automation did not detect, retry, or repair it without a manual prompt. If the missing automation is bot-owned, fix that automation gap too instead of only repairing the current artifact.",
    "If a problem is bot-owned and evidence is sufficient, repair it in this repository, add or update focused regression coverage, run the required local verification, commit the change on the dev branch, and push it to origin/dev according to the repository policy. Then run git pull --rebase after a successful push to update the local dev branch to the latest remote state. The run must not leave this repository with a dirty worktree; if commit, push, or rebase is blocked, record the exact blocker and stop instead of leaving uncommitted edits behind.",
    "If a problem is target-project-owned, external, blocked on credentials, blocked on owner/product decision, or unsafe to auto-edit, record the exact blocker with durable evidence. Do not use vague owner-decision, capacity, or retry-limit wording when the evidence supports a retryable bot-owned repair.",
    "Avoid broad rewrites. Prefer small fixes that remove the reason this issue needed manual operator prompting, but do not stop at a known-failure example if the evidence points somewhere else.",
    "Before finalizing, summarize what was checked, what was fixed or queued, why any remaining item could not be fixed automatically, verification results, commit/PR/push state, and whether the working tree is clean.",
  ].join("\\n");
}
