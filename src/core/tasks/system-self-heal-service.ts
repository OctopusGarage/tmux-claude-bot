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
    void runTick({
      now: now(),
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
      runAgentSweep: () => dispatchAgentSelfHealSweep(deps),
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
  });
  if (result.status === "blocked") {
    log.info("system self-heal agent sweep deferred", { data: { reason: result.reason } });
    return "blocked";
  }
  log.info("system self-heal agent sweep queued", {
    data: { runId: result.runId, supervisorSession: result.supervisorSession },
  });
  return "queued";
}

function buildAgentSelfHealRequirement(): string {
  return [
    "Act like the operator asked: check the last 24 hours of tmux-claude-bot automation health, identify anything abnormal, and fix everything that is safe to fix without waiting for another prompt.",
    "Do not limit yourself to a fixed checklist. Cross-check task ledger state, Repair Coordinator queues, Loop Supervisor WorkOrders, active worker leases, Runtime Guardian findings, Resource Guardian/admission state, service logs, git state, open PR/CI state when relevant, and maintained docs/config drift.",
    "If a problem is bot-owned and evidence is sufficient, repair it in this repository, add or update focused regression coverage, run the required local verification, commit, and push according to the repository policy.",
    "If a problem is target-project-owned, external, blocked on credentials, blocked on owner/product decision, or unsafe to auto-edit, record the exact blocker and leave durable evidence instead of guessing.",
    "Avoid broad rewrites. Prefer small fixes that remove the reason this issue needed manual operator prompting.",
    "Before finalizing, summarize what was checked, what was fixed or queued, what remains blocked with evidence, verification results, commit/PR/push state, and whether the working tree is clean.",
  ].join("\\n");
}
