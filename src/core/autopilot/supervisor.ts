import { createLogger } from "../../shared/utils/logger.js";
import { resolveAgentKind } from "../agents/agentKindMap.js";
import { profileFor } from "../agents/registry.js";
import { sendContextReset } from "../command/context-reset.js";
import type { HandlerDeps } from "../deps.js";
import { getPathBySession } from "../projects/sessionPathMap.js";
import type { UsageSnapshot } from "../read/usage.js";
import { type CheckRunner, cachedExecCheckRunner } from "./check-runner.js";
import { getGoal } from "./goals/catalog.js";
import { decideGoal } from "./goals/goal-decision.js";
import { advanceCycle } from "./goals/goal-state.js";
import { intentToText } from "./goals/intent.js";
import { govern } from "./governor.js";
import { decide } from "./rules.js";
import { observeSignal } from "./signal.js";
import type { AutopilotStore } from "./state-store.js";
import type { Action, AutopilotState } from "./types.js";

const log = createLogger("autopilot.supervisor");

type Probes = {
  paneIsAnimating: (session: string) => Promise<boolean>;
  lastActivityAt: (session: string) => Promise<number | null>;
  recentAssistant?: (session: string) => Promise<string>;
  runCheck?: CheckRunner;
  readUsage?: (session: string) => Promise<UsageSnapshot | null>;
};

let seq = 0;
function nextId(): string {
  seq += 1;
  return `autopilot-${seq}`;
}

/** Did a concurrent user command (/autopilot off|stop|on|goal|confirm|reject)
 * change the session's control state since `before` was captured at tick start?
 * The goal branch awaits a `check` that can run for minutes; re-reading before a
 * write lets us drop this tick's computed state rather than clobber a command
 * that landed mid-await. Relies on AutopilotStore being a SYNCHRONOUS in-process
 * map (JsonMapStore) so a command handler's store.set is visible to store.get in
 * the same event loop; it is NOT a fence for an async/remote KV. */
function userChangedSince(store: AutopilotStore, session: string, before: AutopilotState): boolean {
  const latest = store.get(session);
  return (
    latest.enabled !== before.enabled ||
    (latest.goalQueue ?? []).join(",") !== (before.goalQueue ?? []).join(",") ||
    latest.rounds !== before.rounds ||
    latest.optOut !== before.optOut ||
    latest.humanConfirmed !== before.humanConfirmed ||
    latest.humanGatePending !== before.humanGatePending
  );
}

async function execute(
  deps: HandlerDeps,
  session: string,
  action: Action,
  state: AutopilotState,
): Promise<AutopilotState> {
  const cfg = deps.config.autopilot;
  switch (action.kind) {
    case "nudge":
      deps.queue.enqueue({
        id: nextId(),
        text: action.text,
        chatId: "autopilot",
        action: "text",
        sessionName: session,
        ephemeral: true,
        resolve: () => {},
        reject: () => {},
      });
      log.info("autopilot nudge enqueued", { session, data: { text: action.text } });
      return state;
    case "recover": {
      await deps.bridge.sendRawKey("Escape", session).catch(() => {});
      const backspaces = Math.min(state.recoveries + 1, cfg.maxRecoveryAttempts) * 10;
      for (let i = 0; i < backspaces; i++) {
        await deps.bridge.sendRawKey("BSpace", session).catch(() => {});
      }
      await deps.bridge.sendKeys(cfg.idlePromptText, session).catch(() => {});
      log.info("autopilot recovery sent", { session });
      return state;
    }
    case "pauseNotify":
      await deps.notifier.broadcast({ kind: "paused", session, reason: action.reason });
      return { ...state, enabled: false };
    case "stop":
      await deps.notifier.broadcast({ kind: "stopped", session, reason: action.reason });
      return { ...state, enabled: false };
    case "none":
      return state;
  }
}

/** Run one observe→decide→govern→execute cycle for a session. Returns the
 * executed action. Best-effort: never throws into the caller. */
export async function runSupervisorTick(
  deps: HandlerDeps,
  store: AutopilotStore,
  session: string,
  now: number,
  probes?: Probes,
): Promise<Action> {
  const state = store.get(session);
  if (!state.enabled) return { kind: "none" };
  try {
    const cfg = deps.config.autopilot;
    const signal = await observeSignal(deps, session, state, now, probes);

    // Goal branch: if a goal is active, drive it before the Layer-1 keep-alive path.
    const goal = state.goalId ? getGoal(state.goalId) : undefined;
    if (goal) {
      const idle = !signal.busy && signal.queueEmpty;
      const agentKind = await resolveAgentKind(deps.configResolver, session).catch(
        () => "claude" as const,
      );
      const cwd = getPathBySession(session) ?? undefined;

      // Wall-clock budget applies to goal runs too (govern() only covers Layer-1).
      const wallMs = goal.budget?.maxWallClockMs ?? cfg.maxWallClockMs;
      if (state.startedAt !== undefined && now - state.startedAt >= wallMs) {
        if (!userChangedSince(store, session, state)) {
          // Write before the broadcast await so a command can't land in between.
          store.set(session, { ...store.get(session), enabled: false });
          await deps.notifier.broadcast({ kind: "wallClock", session });
        }
        return { kind: "stop", reason: "goal wall-clock budget exhausted" };
      }

      // Between-goals context reset: a prior goal finalized and queued an op.
      // Run it at the idle boundary, before the next goal's first prompt. The
      // next-goal inject is busy-gated in decideGoal, so the op always precedes it.
      if (state.pendingContextOp) {
        if (!idle) return { kind: "none" }; // wait until the just-finalized agent is idle
        if (userChangedSince(store, session, state)) return { kind: "none" };
        const op = state.pendingContextOp;
        await sendContextReset(deps, session, op).catch((err) =>
          log.warn("autopilot context reset failed", { err, data: { session, op } }),
        );
        const { pendingContextOp: _done, ...rest } = store.get(session);
        store.set(session, rest);
        log.info("autopilot context reset before next goal", {
          session,
          data: { op, goalId: state.goalId },
        });
        return { kind: "none" };
      }

      // Usage gate only at an idle boundary — decideGoal can't act while busy, so
      // reading usage on every busy tick is wasted I/O.
      // Bug #3: viaScheduler sessions are governed by the scheduler's pool-level quota
      // authority (pausePool/resumePool). The supervisor's per-session usage-gate must
      // not fire for them — it would race and clobber the scheduler's account.
      if (idle && cfg.usagePausePct > 0 && !state.viaScheduler) {
        const readUsage =
          probes?.readUsage ??
          ((s: string) =>
            cwd
              ? profileFor(agentKind)
                  .readUsage(deps.configResolver, s, cwd)
                  .catch(() => null)
              : Promise.resolve(null));
        const snap = await readUsage(session).catch(() => null);
        if (
          snap &&
          [snap.contextPct, snap.fiveHourPct, snap.sevenDayPct].some(
            (p) => p !== null && p >= cfg.usagePausePct,
          )
        ) {
          if (!userChangedSince(store, session, state)) {
            store.set(session, { ...store.get(session), enabled: false });
            await deps.notifier.broadcast({ kind: "usage", session, pct: cfg.usagePausePct });
          }
          return { kind: "pauseNotify", reason: "usage budget reached" };
        }
      }

      // After a /autopilot reject ("keep going"): re-prompt the agent with the
      // phase intent. Enqueuing it makes the session busy next tick, so decideGoal
      // (which returns early while busy) won't re-evaluate the stale done-claim until
      // the agent has produced fresh output — preventing the gate from immediately
      // re-arming on the old sentinel. The cooldown additionally throttles re-prompts.
      if (state.reworkPending) {
        if (userChangedSince(store, session, state)) return { kind: "none" };
        const phase = goal.phases[state.phaseIndex ?? 0];
        const text = phase ? intentToText(phase.intent, agentKind) : cfg.idlePromptText;
        deps.queue.enqueue({
          id: nextId(),
          text,
          chatId: "autopilot",
          action: "text",
          sessionName: session,
          ephemeral: true,
          resolve: () => {},
          reject: () => {},
        });
        store.set(session, {
          ...store.get(session),
          reworkPending: false,
          cooldownUntil: now + cfg.cooldownMs,
        });
        return { kind: "nudge", text };
      }

      const runCheck = probes?.runCheck ?? cachedExecCheckRunner;
      const outcome = await decideGoal(goal, signal, state, { agentKind, runCheck, cwd });

      // A /autopilot command may have landed during the (possibly minutes-long)
      // check; if so, drop this tick's computed action and recompute next tick.
      if (userChangedSince(store, session, state)) return { kind: "none" };

      const cap = goal.budget?.maxIterations ?? cfg.maxIterations;
      switch (outcome.kind) {
        case "inject": {
          if ((outcome.nextState.goalIterations ?? 0) > cap) {
            // write before the broadcast await so a concurrent command isn't clobbered
            store.set(session, { ...outcome.nextState, enabled: false });
            log.info("autopilot goal stopped: max iterations", {
              session,
              data: { goalId: goal.id, cap },
            });
            await deps.notifier.broadcast({ kind: "maxIter", session });
            return { kind: "stop", reason: "goal max iterations" };
          }
          if (state.cooldownUntil !== undefined && now < state.cooldownUntil) {
            return { kind: "none" };
          }
          deps.queue.enqueue({
            id: nextId(),
            text: outcome.text,
            chatId: "autopilot",
            action: "text",
            sessionName: session,
            ephemeral: true,
            resolve: () => {},
            reject: () => {},
          });
          store.set(session, { ...outcome.nextState, cooldownUntil: now + cfg.cooldownMs });
          return { kind: "nudge", text: outcome.text };
        }
        case "advance":
          log.info("autopilot goal phase advanced", {
            session,
            data: { goalId: goal.id, phaseIndex: outcome.nextState.phaseIndex ?? 0 },
          });
          store.set(session, outcome.nextState);
          return { kind: "none" };
        case "awaitHuman":
          // Write the gate state BEFORE the broadcast: the broadcast is network I/O,
          // and a confirm tapped during it would otherwise be overwritten by this set.
          store.set(session, outcome.nextState);
          log.info("autopilot awaiting human confirm", { session, data: { goalId: goal.id } });
          await deps.notifier.broadcast({ kind: "awaitHuman", session, goalId: goal.id });
          return { kind: "pauseNotify", reason: outcome.reason };
        case "finalize": {
          const step = advanceCycle(outcome.nextState);
          if (step.kind === "next") {
            const nextState =
              cfg.betweenGoals === "none"
                ? step.state
                : { ...step.state, pendingContextOp: cfg.betweenGoals };
            store.set(session, nextState);
            log.info("autopilot goal complete, advancing cycle", {
              session,
              data: {
                from: goal.id,
                to: step.state.goalId,
                round: (step.state.roundsDone ?? 0) + 1,
                contextOp: nextState.pendingContextOp ?? "none",
              },
            });
            await deps.notifier.broadcast({
              kind: "goalAdvance",
              session,
              goalId: step.state.goalId ?? "",
              pos: (step.state.queuePos ?? 0) + 1,
              total: step.state.goalQueue?.length ?? 1,
              round: (step.state.roundsDone ?? 0) + 1,
              rounds: step.state.rounds ?? 1,
            });
            return { kind: "none" };
          }
          const isCycle =
            (outcome.nextState.goalQueue?.length ?? 1) > 1 || (outcome.nextState.rounds ?? 1) > 1;
          store.set(session, { ...outcome.nextState, enabled: false });
          log.info("autopilot finished, stopping", {
            session,
            data: { goalId: goal.id, isCycle, reason: outcome.reason },
          });
          await deps.notifier.broadcast(
            isCycle
              ? { kind: "cycleComplete", session, rounds: outcome.nextState.rounds ?? 1 }
              : { kind: "complete", session, goalId: goal.id },
          );
          return { kind: "pauseNotify", reason: outcome.reason };
        }
        case "none":
          // While a human gate is pending the session is intentionally paused for
          // the user — do NOT fall through to Layer-1 (its stuck-prompt / api-error
          // rules would inject into the agent and corrupt the wait).
          if (state.humanGatePending) return { kind: "none" };
          break;
      }
    }

    // Completion-aware keep-alive: a pure keep-alive task that emits the done
    // marker is finished — stop and notify instead of nudging "继续" forever.
    if (
      state.pureKeepAlive &&
      !state.goalId &&
      signal.sentinels.includes(cfg.keepAliveDoneMarker)
    ) {
      if (!userChangedSince(store, session, state)) {
        store.set(session, { ...store.get(session), enabled: false });
        log.info("autopilot keep-alive task complete, stopping", {
          session,
          data: { marker: cfg.keepAliveDoneMarker },
        });
        await deps.notifier.broadcast({ kind: "keepaliveDone", session });
      }
      return { kind: "stop", reason: "keep-alive task complete" };
    }

    // Layer-1 keep-alive: observe→decide→govern→execute
    const decision = decide(signal, { state, config: cfg, now });
    const governed = govern(decision, signal, { state, config: cfg, now });
    const finalState = await execute(deps, session, governed.action, governed.state);
    // Re-read the latest before writing back so a concurrent disable (e.g. /autopilot off
    // arriving during `execute`) is not overwritten.
    const latest = store.get(session);
    store.set(session, { ...finalState, enabled: finalState.enabled && latest.enabled });
    return governed.action;
  } catch (err) {
    log.warn("supervisor tick failed", { session, err });
    return { kind: "none" };
  }
}
