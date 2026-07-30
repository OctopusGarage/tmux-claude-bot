import type { Messages } from "../i18n/index.js";
import { setGlobalKeepAlive } from "./global-flag.js";
import { getGoal, listGoals } from "./goals/catalog.js";
import { startCycleState } from "./goals/goal-state.js";
import type { AutopilotStore } from "./state-store.js";
import { defaultState } from "./types.js";

export const MAX_ROUNDS_FALLBACK = 10;

/** Begin a fresh autopilot run for a session — resets all safety counters and
 * stamps startedAt so the wall-clock budget starts now. */
export function autopilotEnable(
  store: AutopilotStore,
  session: string,
  opts: { keepAlive?: boolean } = {},
): void {
  const prev = store.get(session);
  store.set(session, {
    ...defaultState(prev.persona),
    enabled: true,
    pureKeepAlive: opts.keepAlive ?? prev.pureKeepAlive,
    startedAt: Date.now(),
  });
}

export function autopilotDisable(store: AutopilotStore, session: string): void {
  // optOut so global keep-alive won't immediately re-enroll a session the user
  // explicitly turned off. `/autopilot on` clears it (autopilotEnable resets state).
  store.set(session, { ...store.get(session), enabled: false, optOut: true });
}

export function autopilotSetKeepAlive(store: AutopilotStore, session: string, on: boolean): void {
  store.set(session, { ...store.get(session), pureKeepAlive: on });
}

/** Hard stop: disable and reset counters so a later enable starts clean. Sets
 * optOut so global keep-alive won't immediately re-enroll the just-stopped
 * session (`/autopilot on`/`goal` clears it). */
export function autopilotStop(store: AutopilotStore, session: string): void {
  const prev = store.get(session);
  store.set(session, { ...defaultState(prev.persona), enabled: false, optOut: true });
}

export function autopilotStatusText(
  store: AutopilotStore,
  session: string,
  msgs: Messages,
): string {
  const s = store.get(session);
  // In goal mode the bot intervenes via goal-prompt injections (goalIterations);
  // the keep-alive `iterations` counter stays 0 there. Show the mode-relevant
  // count so the status isn't stuck at "intervened 0 times" while a goal runs.
  const iterations = s.goalId !== undefined ? (s.goalIterations ?? 0) : s.iterations;
  return msgs.autopilotStatus({
    enabled: s.enabled,
    pureKeepAlive: s.pureKeepAlive,
    iterations,
    persona: s.persona,
    ...(s.goalId !== undefined && { goal: { id: s.goalId, phaseIndex: s.phaseIndex ?? 0 } }),
  });
}

export type AutopilotVerb =
  | { verb: "status" }
  | { verb: "on"; keepAlive: boolean }
  | { verb: "off" }
  | { verb: "keepalive"; on: boolean }
  | { verb: "stop" }
  | { verb: "goals"; ids: string[]; rounds: number }
  | { verb: "confirm" }
  | { verb: "reject" }
  | { verb: "global"; on: boolean }
  | { verb: "unknown"; raw: string };

export function parseAutopilotVerb(
  arg: string,
  maxRounds: number = MAX_ROUNDS_FALLBACK,
): AutopilotVerb {
  const a = arg.trim().toLowerCase();
  if (a === "") return { verb: "status" };
  if (a === "on") return { verb: "on", keepAlive: true };
  if (a === "off") return { verb: "off" };
  if (a === "stop") return { verb: "stop" };
  if (a.startsWith("keepalive")) return { verb: "keepalive", on: !a.includes("off") };
  if (a.startsWith("goal ") || a.startsWith("goals ")) {
    const rest = arg.trim().replace(/^goals?\s+/i, "");
    const m = rest.match(/^(.*?)(?:\s+rounds\s+(\d+))?$/i);
    const ids = (m?.[1] ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    const rounds = Math.min(
      Math.max(1, maxRounds), // honour the configured cap, not just the fallback
      Math.max(1, m?.[2] ? Number.parseInt(m[2], 10) : 1),
    );
    if (ids.length === 0) return { verb: "unknown", raw: arg.trim() };
    return { verb: "goals", ids, rounds };
  }
  if (a === "goal" || a === "goals") return { verb: "unknown", raw: arg.trim() };
  if (a === "confirm") return { verb: "confirm" };
  if (a === "reject") return { verb: "reject" };
  if (a.startsWith("global")) return { verb: "global", on: !a.includes("off") };
  return { verb: "unknown", raw: arg.trim() };
}

export function applyAutopilotVerb(
  store: AutopilotStore,
  session: string,
  arg: string,
  msgs: Messages,
  maxRounds: number = MAX_ROUNDS_FALLBACK,
): string {
  const v = parseAutopilotVerb(arg, maxRounds);
  switch (v.verb) {
    case "on":
      autopilotEnable(store, session, { keepAlive: v.keepAlive });
      break;
    case "off":
      autopilotDisable(store, session);
      break;
    case "keepalive":
      autopilotSetKeepAlive(store, session, v.on);
      break;
    case "stop":
      autopilotStop(store, session);
      break;
    case "goals": {
      const unknown = v.ids.filter((id) => !getGoal(id));
      if (unknown.length > 0) {
        return msgs.autopilotUnknownGoal(
          listGoals()
            .map((x) => x.id)
            .join(", "),
        );
      }
      store.set(session, startCycleState(store.get(session), v.ids, v.rounds));
      return msgs.autopilotGoalStarted(v.ids.join(", "));
    }
    case "confirm":
      store.set(session, {
        ...store.get(session),
        humanConfirmed: true,
        humanGatePending: false,
      });
      break;
    case "reject":
      // "keep going": clear the gate, rewind the seq to its start, and flag a rework
      // so the supervisor re-prompts the agent next tick (otherwise the stale
      // done-claim would just re-arm the same gate without any further work).
      store.set(session, {
        ...store.get(session),
        humanConfirmed: false,
        humanGatePending: false,
        seqIndex: 0,
        reworkPending: true,
      });
      break;
    case "global":
      setGlobalKeepAlive(v.on);
      return msgs.autopilotGlobal(v.on);
    case "unknown":
      return msgs.autopilotUsage(v.raw);
    case "status":
      break;
  }
  return autopilotStatusText(store, session, msgs);
}
