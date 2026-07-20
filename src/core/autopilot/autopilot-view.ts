import type { Messages } from "../i18n/index.js";
import { autopilotStatusText, MAX_ROUNDS_FALLBACK } from "./controls.js";
import { isGlobalKeepAlive } from "./global-flag.js";
import { listGoals } from "./goals/catalog.js";
import { goalTitle } from "./goals/goal-title.js";
import { goalSkillIds } from "./goals/skill-dependencies.js";
import { getPicker } from "./picker-state.js";
import type { AutopilotStore } from "./state-store.js";

export type AutopilotMode = "off" | "keepalive" | "cycle";
export type AutopilotView = {
  enabled: boolean;
  mode: AutopilotMode;
  statusLine: string;
  gatePending: boolean;
  globalOn: boolean;
  cycle?: { goalId: string; pos: number; total: number; round: number; rounds: number };
  goals: { id: string; title: string; selected: boolean; skills: string[] }[];
  rounds: number;
  maxRounds: number; // the configured round cap (so out-of-process surfaces like the TUI can clamp correctly)
};

export function buildAutopilotView(
  store: AutopilotStore,
  session: string,
  msgs: Messages,
  maxRounds: number = MAX_ROUNDS_FALLBACK,
): AutopilotView {
  const s = store.get(session);
  const picker = getPicker(session);
  const mode: AutopilotMode = !s.enabled ? "off" : s.goalId !== undefined ? "cycle" : "keepalive";
  const cycle =
    mode === "cycle" // mode is "cycle" only when goalId is defined (see `mode` above)
      ? {
          goalId: s.goalId as string,
          pos: (s.queuePos ?? 0) + 1,
          total: s.goalQueue?.length ?? 1,
          round: (s.roundsDone ?? 0) + 1,
          rounds: s.rounds ?? 1,
        }
      : undefined;
  return {
    enabled: s.enabled,
    mode,
    statusLine: autopilotStatusText(store, session, msgs),
    gatePending: s.humanGatePending ?? false,
    globalOn: isGlobalKeepAlive(),
    ...(cycle ? { cycle } : {}),
    goals: listGoals().map((g) => ({
      id: g.id,
      title: goalTitle(msgs, g),
      selected: picker.selected.includes(g.id),
      skills: goalSkillIds(g),
    })),
    rounds: picker.rounds,
    maxRounds,
  };
}
