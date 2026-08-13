import { createLogger } from "../../shared/utils/logger.js";
import { profileFor } from "../agents/registry.js";
import type { AgentKind } from "../agents/types.js";
import { admitAutomationWork } from "../automation/admission.js";
import type { AutopilotNotice } from "../autopilot/notifier.js";
import type { HandlerDeps } from "../deps.js";
import { getPathBySession } from "../projects/sessionPathMap.js";
import type { UsageSnapshot } from "../read/usage.js";
import { DailyTaskLedger } from "../tasks/task-ledger.js";
import { accountQuotaHit, pausePool, resumeAtFrom, resumePool } from "./quota.js";
import { renderSummary } from "./report.js";
import { resumeUngatedTasks } from "./resume.js";
import { failOrRetry, reconcile } from "./scheduler.js";
import { SchedulerStore } from "./scheduler-store.js";
import { hasActiveRun, materializeRun, nextFire } from "./scheduling.js";
import { type Plan, type PoolState, type Run, type TaskState, TERMINAL_STATUSES } from "./types.js";

const log = createLogger("scheduler.loop");

export type TickCtx = {
  now: number;
  plans: Plan[];
  run: Run | undefined;
  pools: Record<string, PoolState>;
  /** planId → last fire epoch-ms; MUTATED in place to prevent re-fire */
  lastFired: Record<string, number>;
  resolveSession: (t: TaskState) => string;
  readUsage: (agent: AgentKind) => Promise<UsageSnapshot | null>;
  isGated: (session: string) => boolean;
  quotaPct: number; // account-quota pause threshold (config.scheduler.quotaPct)
  reprobeMs: number; // fallback resume delay when no reset time is known
  save: (run: Run | undefined, pools: Record<string, PoolState>) => void;
  notify: (notice: AutopilotNotice) => void;
  /** Bug #3 fix: check whether a tmux session+pane is alive.
   * Used to detect dead sessions for running tasks and fail/retry them.
   * Defaults to () => true when omitted (backward-compat). */
  isAlive?: (session: string) => Promise<boolean>;
  /** Single-writer fix: re-read the live active run at the START of the
   * synchronous critical section, AFTER the tick's hoisted awaits resolve, so a
   * control handler (stopRun/pauseRun/resumeRun/startPlan) that wrote the store
   * directly during those awaits is honored instead of clobbered. Returns the
   * current store run (or undefined when no run is active). When omitted, the
   * re-read is a no-op using the start-of-tick snapshot (backward-compat for
   * tests that build a ctx without it). */
  getActiveRun?: () => Run | undefined;
  /** Bug #3 fix: announce a newly-active run (scheduled OR manual `/batch start`)
   * exactly once. The scheduler-fire block used to inline the `batchRunStarted`
   * notify, which missed runs started directly via `startPlan` (it writes the
   * store without notifying, then the tick adopts it). Centralizing the announce
   * here, de-duped by runId, covers both paths. Optional: tests without it are
   * unaffected. */
  announceRun?: (run: Run) => void;
  taskLedger?: DailyTaskLedger;
};

/** Bug #1/#9 fix: derive the pool `paused` flags PURELY from the run, every tick.
 *
 * `pools` is an in-memory closure mutated only by `save`; nothing clears a
 * quota-paused entry when the run is stopped/replaced/completed (`stopRun` nulls
 * the run but never touches pools; the external-stop abort path returns without a
 * save). A stale `{ agent: { paused: true, resumeAt } }` then blocks the NEXT
 * run's tasks for that agent until the old resumeAt elapses.
 *
 * So the run is the single source of truth: the result holds EXACTLY the agents
 * that have a `paused-quota` task — `{ paused: true, resumeAt: <preserved> ?? now }`
 * — and NOTHING else. An agent with no paused-quota task has no entry (unpaused).
 * A stopped/completed/replaced run has no paused-quota tasks → empty pools → the
 * stale flag self-heals on the next tick. A legitimately-paused pool still has
 * paused-quota tasks → stays paused with its resumeAt preserved → `resumePool`
 * works unchanged. Pure; takes `now` (no `Date.now()` inside). */
export function derivePools(
  pools: Record<string, PoolState>,
  run: Run | null | undefined,
  now: number,
): Record<string, PoolState> {
  const result: Record<string, PoolState> = {};
  if (!run) return result;
  const pausedAgents = new Set<AgentKind>();
  for (const t of run.tasks) {
    if (t.status === "paused-quota") pausedAgents.add(t.agent);
  }
  for (const agent of pausedAgents) {
    result[agent] = { paused: true, resumeAt: pools[agent]?.resumeAt ?? now };
  }
  return result;
}

/** One scheduler pass: schedule → quota → resume gates → admit → finalize → persist.
 *
 * Single-writer structure: every store/autopilot mutation lives in ONE
 * synchronous critical section (step 4 onward) with NO awaits, so a concurrent
 * control handler (stopRun/pauseRun/...) cannot interleave INTO it on the single
 * JS thread. The only awaits run in the async PHASE up front (liveness + usage
 * pre-fetch); they mutate ONLY the LOCAL `run`, never the store. A re-read at the
 * top of the critical section honors any control that landed during those awaits. */
export async function schedulerTick(ctx: TickCtx): Promise<void> {
  let run = ctx.run;
  let pools = ctx.pools;

  // ───────────────────────── async PHASE (no store writes) ───────────────────
  // Bug #3 fix: for every "running" task whose tmux session is no longer alive,
  // apply failOrRetry immediately so the task doesn't hang indefinitely waiting
  // for a completion notice that will never arrive (e.g. after a desktop-kill or
  // a bot restart with a dead session).
  if (run && ctx.isAlive) {
    const livenessChecks = run.tasks
      .filter((t) => t.status === "running" && t.sessionName !== undefined)
      .map(async (t) => ({
        t,
        alive: await (ctx.isAlive as NonNullable<TickCtx["isAlive"]>)(t.sessionName as string),
      }));
    const results = await Promise.all(livenessChecks);
    for (const { t, alive } of results) {
      if (!alive) {
        log.warn("scheduler: running task has dead session; failing/retrying", {
          data: { project: t.project, agent: t.agent, session: t.sessionName },
        });
        run = {
          ...run,
          tasks: run.tasks.map((x) => (x === t ? failOrRetry(t, "dead session") : x)),
        };
      }
    }
  }

  // Derive caps for the PRE-FETCH from the post-liveness snapshot run (a task
  // that just failed for a dead session no longer counts as "running"). The
  // quota loop below re-derives caps from the FINAL run (after schedule-fire /
  // external-adopt), since a freshly-materialized run has a different planId.
  const plan0 = ctx.plans.find((p) => p.id === run?.planId);
  const caps0 = plan0?.pools ?? {};

  // Pre-fetch account usage for exactly the agents the quota loop will consume:
  // an unpaused pool with a still-running task on a non-paused run. This is the
  // LAST await; everything after the critical-section boundary reads this map.
  const usage = new Map<AgentKind, UsageSnapshot | null>();
  if (run && run.status !== "paused") {
    for (const agent of Object.keys(caps0) as AgentKind[]) {
      if (
        !pools[agent]?.paused &&
        run.tasks.some((t) => t.agent === agent && t.status === "running")
      ) {
        usage.set(agent, await ctx.readUsage(agent).catch(() => null));
      }
    }
  }

  // ─────────────────── SYNCHRONOUS CRITICAL SECTION (NO awaits below) ─────────
  // Re-read the live store to honor a control (stop/pause/resume/start) that
  // wrote it DIRECTLY while we were awaiting above. Without `getActiveRun` this
  // is a no-op using the start-of-tick snapshot (backward-compat).
  const current = ctx.getActiveRun ? ctx.getActiveRun() : run;
  if (run !== undefined && current === undefined) {
    // External stop landed during our awaits: the run was nulled and its sessions
    // already released. Do NOT resurrect the run (save) or re-enable its sessions
    // (reconcile) — just bail. The local `run` we built is now stale and must die.
    log.info("scheduler tick aborted: run stopped during await", {
      data: { runId: run.runId },
    });
    return;
  }
  if (run === undefined || (current !== undefined && current.runId !== run.runId)) {
    // No run at start-of-tick → adopt an externally-started run if one appeared.
    // OR the store now holds a DIFFERENT run (a stop+start within our awaits
    // replaced it): our snapshot's notice/liveness edits belong to the old run, so
    // adopt `current` wholesale rather than resurrecting the stale snapshot.
    run = current;
    if (run) log.info("scheduler adopted external run", { data: { runId: run.runId } });
  } else if (current && current.status !== run.status) {
    // Same run, external pause/resume landed: honor the new status but keep our
    // local notice/liveness task updates (which the control handler did not see).
    run = { ...run, status: current.status };
    log.info("scheduler adopted external status", {
      data: { runId: run.runId, status: current.status },
    });
  }

  // Bug #1/#9 fix: re-derive pool-paused PURELY from the resolved run, every tick,
  // BEFORE the quota loop. A stopped/replaced/completed run has no paused-quota
  // tasks → empty pools → any stale paused flag is cleared so the next run admits.
  pools = derivePools(pools, run, ctx.now);

  if (!hasActiveRun(run)) {
    // Fire a plan whose schedule is due, anchored on its last fire so cron/at don't
    // re-fire every tick: `now` fires once (until lastFired set); at/cron fire when
    // the next occurrence after lastFired is <= now.
    const due = ctx.plans.find((p) => {
      if (!p.schedule) return false;
      if (p.schedule.kind === "now") return ctx.lastFired[p.id] === undefined;
      const fireAt = nextFire(p.schedule, ctx.lastFired[p.id] ?? 0);
      return fireAt !== null && fireAt <= ctx.now;
    });
    if (!due?.schedule) {
      ctx.save(run, pools);
      return;
    }
    ctx.lastFired[due.id] =
      due.schedule.kind === "now"
        ? ctx.now
        : (nextFire(due.schedule, ctx.lastFired[due.id] ?? 0) ?? ctx.now);
    run = materializeRun(due, `run-${ctx.now}`, ctx.now);
    recordBatchRunStarted(ctx, due, run);
    // Bug #1/#9: a freshly-materialized run has no paused-quota tasks → no paused
    // pools; re-derive so a just-cleared agent doesn't carry a stale flag.
    pools = derivePools(pools, run, ctx.now);
    log.info("scheduler run started", { data: { plan: due.id, tasks: run.tasks.length } });
  }
  if (!run) {
    ctx.save(run, pools);
    return;
  }

  // Bug #3 fix: announce any newly-active run (scheduled OR manual start) exactly
  // once, centrally (de-duped by runId in startScheduler). Replaces the inline
  // batchRunStarted notify, which missed `/batch start` (writes the store directly).
  ctx.announceRun?.(run);

  // Bug #2 fix: a run whose tasks are ALL terminal must be FINALIZED even when a
  // `/batch pause` landed in the same tick (the status-merge above set "paused").
  // Run the all-terminal completion BEFORE the paused early-return below; otherwise
  // the run freezes as a "paused" zombie with every task done (no batchRunComplete,
  // lastFired not advanced, the slot stuck) until a manual resume.
  if (run.tasks.length > 0 && run.tasks.every((t) => TERMINAL_STATUSES.has(t.status))) {
    finalizeRun(ctx, run, pools);
    return;
  }

  if (run.status === "paused") {
    // user-paused: stop admitting / driving until resumed (in-flight agents finish on their own)
    ctx.save(run, pools);
    return;
  }
  // Re-derive caps from the FINAL run (may differ from caps0 if the run was
  // materialized or externally adopted in this critical section).
  const plan = ctx.plans.find((p) => p.id === run?.planId);
  const caps = plan?.pools ?? {};
  for (const agent of Object.keys(caps) as AgentKind[]) {
    if (pools[agent]?.paused) {
      const before = pools[agent];
      ({ run, pools } = resumePool(run, pools, agent, ctx.now));
      // Bug #6 logging: log only when the pool actually unpaused (now >= resumeAt),
      // symmetric with the "paused pool on account quota" INFO above — not on every
      // still-paused tick.
      if (before.paused && pools[agent]?.paused === false) {
        log.info("scheduler resumed pool", { data: { agent } });
      }
    } else if (run.tasks.some((t) => t.agent === agent && t.status === "running")) {
      // Use the usage snapshot pre-fetched in the async phase (the map only holds
      // entries for exactly this branch's agents), NOT a fresh await — the
      // critical section must stay await-free to remain a single atomic writer.
      const snap = usage.get(agent) ?? null;
      if (accountQuotaHit(snap, ctx.quotaPct)) {
        const resumeAt = resumeAtFrom(snap, ctx.now, ctx.reprobeMs);
        ({ run, pools } = pausePool(run, pools, agent, resumeAt));
        log.info("scheduler paused pool on account quota", { data: { agent, resumeAt } });
        ctx.notify({ kind: "batchPoolPaused", runId: run.runId, agent, resumeAt });
      }
    }
  }

  run = resumeUngatedTasks(run, ctx.isGated);
  // The operator session is never a plan target: plans specify explicit project
  // paths, and the operator has no project path. No exclusion code needed here.
  run = reconcile(run, caps, pools, {
    resolveSession: ctx.resolveSession,
    isGated: ctx.isGated,
    now: ctx.now,
  });

  if (run.tasks.length > 0 && run.tasks.every((t) => TERMINAL_STATUSES.has(t.status))) {
    finalizeRun(ctx, run, pools);
    return;
  }
  ctx.save(run, pools);
}

/** Finalize an all-terminal run: mark the run done, broadcast completion,
 * advance the plan's lastFired anchor (so cron
 * catch-up ticks are skipped — nextFire(ctx.now) returns the next FUTURE
 * occurrence), and persist with NO active run. Used by BOTH the early
 * all-terminal check (Bug #2: completes even when a pause landed this tick) and
 * the normal end-of-tick completion — so the logic is never duplicated. */
function finalizeRun(ctx: TickCtx, run: Run, pools: Record<string, PoolState>): void {
  const done: Run = { ...run, status: "done", endedAt: ctx.now };
  recordBatchRunCompleted(ctx, done);
  log.info("scheduler run complete", { data: { plan: done.planId } });
  ctx.notify({ kind: "batchRunComplete", runId: done.runId, summary: renderSummary(done) });
  ctx.lastFired[done.planId] = ctx.now;
  ctx.save(undefined, pools);
}

function batchTaskId(run: Run): string {
  return `batch:${run.planId}:${run.runId}`;
}

function recordBatchRunStarted(ctx: TickCtx, plan: Plan, run: Run): void {
  const ledger = ctx.taskLedger;
  if (!ledger) return;
  const taskId = batchTaskId(run);
  ledger.expect({
    taskId,
    source: "batch-scheduler",
    name: plan.name || plan.id,
    scheduledAt: run.startedAt,
    summary: `${run.tasks.length} task(s)`,
  });
  ledger.start(taskId, run.startedAt);
}

function recordBatchRunCompleted(ctx: TickCtx, run: Run): void {
  const ledger = ctx.taskLedger;
  if (!ledger) return;
  const taskId = batchTaskId(run);
  const plan = ctx.plans.find((candidate) => candidate.id === run.planId);
  ledger.expect({
    taskId,
    source: "batch-scheduler",
    name: plan?.name || run.planId,
    scheduledAt: run.startedAt,
    summary: `${run.tasks.length} task(s)`,
  });
  if (run.tasks.some((task) => task.status === "failed")) {
    ledger.fail(taskId, {
      endedAt: run.endedAt ?? ctx.now,
      error: "one or more batch tasks failed",
      summary: renderSummary(run),
    });
  } else {
    ledger.finish(taskId, {
      endedAt: run.endedAt ?? ctx.now,
      summary: renderSummary(run),
    });
  }
}

/** Start the live scheduler loop + notifier subscription. Returns a stop fn. */
export function startScheduler(deps: HandlerDeps): () => void {
  const intervalMs = deps.config.scheduler.tickMs;
  if (intervalMs <= 0) {
    log.info("scheduler disabled (tickMs=0)");
    return () => {};
  }
  const store = new SchedulerStore();
  const taskLedger = new DailyTaskLedger();
  const quotaPct = deps.config.scheduler.quotaPct;
  const reprobeMs = deps.config.scheduler.reprobeMs;
  const isSessionGated = (_session: string): boolean => false;

  // Bug #1/#9 fix: derive pool-paused PURELY from the active run on boot — the
  // run is the single source of truth, so a persisted-but-stale paused flag (run
  // already stopped/completed) is dropped, and a paused-quota task with a missing
  // pool entry is restored to paused (with its persisted resumeAt preserved).
  let pools: Record<string, PoolState> = derivePools(
    store.getPools(),
    store.getActiveRun(),
    Date.now(),
  );
  const lastFired = store.getLastFired();

  const readUsage = async (agent: AgentKind): Promise<UsageSnapshot | null> => {
    const run = store.getActiveRun();
    const t = run?.tasks.find((x) => x.agent === agent && x.status === "running" && x.sessionName);
    if (!t?.sessionName) return null;
    const sessionName = t.sessionName;
    const cwd = getPathBySession(sessionName) ?? undefined;
    if (!cwd) return null;
    // Bug #5: no isPaneAlive probe here — the tick's liveness pass already
    // failed/retried any dead RUNNING task BEFORE the quota loop calls readUsage,
    // so by here the agent's running task is known-alive (the liveness pass is the
    // single liveness authority; a second probe was a redundant tmux subprocess).
    return profileFor(agent)
      .readUsage(deps.configResolver, sessionName, cwd)
      .catch(() => null);
  };
  // Bug #3 fix: announce a newly-active run once, centrally — covers scheduled
  // fires AND manual `/batch start` (which writes the store directly without
  // notifying). Seeded with the restored run's id so a run recovered on boot is
  // NOT re-announced. De-duped by runId.
  let announcedRunId = store.getActiveRun()?.runId;
  const announceRun = (run: Run): void => {
    if (run.runId === announcedRunId) return;
    announcedRunId = run.runId;
    void deps.notifier.broadcast({
      kind: "batchRunStarted",
      runId: run.runId,
      planId: run.planId,
      tasks: run.tasks.length,
    });
  };

  // Bug #2: serialize + coalesce concurrent tick invocations.
  // Both the setInterval and the notifier subscription call tick(), and schedulerTick
  // is async (awaits readUsage), so two ticks can interleave and produce a lost-update
  // race on `pools`. The in-flight guard below ensures at most one schedulerTick runs
  // at a time; a tick that arrives while one is running is coalesced into one follow-up.
  let ticking = false;
  let pending = false;
  const tick = (): void => {
    if (ticking) {
      pending = true;
      return;
    }
    ticking = true;
    const tickNow = Date.now();
    void schedulerTick({
      now: tickNow,
      plans: store.listPlans(),
      run: store.getActiveRun(),
      pools,
      lastFired,
      resolveSession: (t) => t.sessionName ?? t.project,
      readUsage,
      isGated: (session) =>
        isSessionGated(session) ||
        !admitAutomationWork(
          {
            source: "batch-scheduler",
            trigger: "background",
            weight: "heavy",
            now: tickNow,
          },
          { hostPower: deps.config.hostPower },
        ).allowed,
      quotaPct,
      reprobeMs,
      save: (run, p) => {
        pools = p;
        store.setActiveRun(run ?? null);
        store.setLastFired(lastFired);
        store.setPools(p);
      },
      notify: (n) => void deps.notifier.broadcast(n),
      // Bug #3 fix: liveness check for running tasks (dead session → fail/retry).
      isAlive: (s) => deps.bridge.isPaneAlive(s),
      // Single-writer fix: re-read the live run at the critical-section boundary
      // so a control handler's direct store write (during our awaits) is honored.
      getActiveRun: () => store.getActiveRun(),
      // Bug #3 fix: announce a newly-active run once (scheduled OR manual start).
      announceRun,
      taskLedger,
    })
      .catch((err) => log.warn("scheduler tick failed", { err }))
      .finally(() => {
        ticking = false;
        if (pending) {
          pending = false;
          tick();
        }
      });
  };

  deps.notifier.register(async () => {
    // Only prod an active run; plan firing is handled by the interval.
    if (!store.getActiveRun()) return;
    tick();
  });

  log.info("scheduler enabled", { data: { intervalMs, quotaPct, reprobeMs } });
  const timer = setInterval(tick, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
