import type { Action, Decision, Rule, RuleContext, SessionSignal } from "./types.js";

const NONE: Action = { kind: "none" };

/** Layer 1 keep-alive rules. Each emits the natural intent; the governor
 * (govern()) enforces cooldown, iteration/wall-clock caps, loop detection and
 * the conservative persona. First match wins. */
export const LAYER1_RULES: Rule[] = [
  {
    id: "busy",
    when: (s) => s.busy || !s.queueEmpty,
    act: () => NONE,
  },
  {
    id: "hard-stop",
    when: (s) => s.pane.hardStop,
    act: () => ({ kind: "pauseNotify", reason: "agent hit a hard stop (credits/usage/context)" }),
  },
  {
    id: "api-error",
    when: (s) => s.pane.apiError,
    // a distinct, clearer prompt than the idle nudge — a bare "继续" could be
    // misread by the agent as continuing some other task.
    act: (_s, ctx) => ({ kind: "nudge", text: ctx.config.apiErrorPromptText }),
  },
  {
    id: "stuck-prompt",
    when: (s) => s.pane.inputPromptWaiting,
    act: () => ({ kind: "recover" }),
  },
  {
    id: "idle-unfinished",
    // Suppressed while a goal's human-confirmation gate is pending to avoid spamming the agent
    when: (s, ctx) =>
      s.queueEmpty &&
      !s.turnFinished &&
      s.idleForMs >= ctx.config.idleGraceMs &&
      !ctx.state.humanGatePending &&
      // Fires for pure keep-alive sessions (no goal) and for sessions with an active goal
      (ctx.state.pureKeepAlive || ctx.state.goalId !== undefined),
    act: (_s, ctx) => ({
      kind: "nudge",
      text:
        ctx.state.pureKeepAlive && ctx.state.goalId === undefined
          ? `${ctx.config.idlePromptText}\n${ctx.config.keepAliveDonePrompt}`
          : ctx.config.idlePromptText,
    }),
  },
];

export function decide(signal: SessionSignal, ctx: RuleContext): Decision {
  for (const rule of LAYER1_RULES) {
    if (rule.when(signal, ctx)) return { ruleId: rule.id, action: rule.act(signal, ctx) };
  }
  return { ruleId: "none", action: NONE };
}
