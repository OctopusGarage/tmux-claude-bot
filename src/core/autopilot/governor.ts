import { nextDelayMs } from "./retry.js";
import type { Action, AutopilotState, Decision, RuleContext, SessionSignal } from "./types.js";

export type Governed = { action: Action; state: AutopilotState };

function digestOf(s: SessionSignal): string {
  return `${s.pane.apiError ? "A" : ""}${s.pane.hardStop ? "H" : ""}${s.pane.inputPromptWaiting ? "P" : ""}|${s.turnFinished ? "f" : "u"}|${s.progressAt}`;
}

/** Enforce caps / cooldown / backoff / loop-detection / conservative persona on a
 * rule's intent, returning the final action and the advanced state. Pure. */
export function govern(decision: Decision, signal: SessionSignal, ctx: RuleContext): Governed {
  const { action, ruleId } = decision;
  const s = { ...ctx.state };
  const { config, now } = ctx;

  // Pass-through terminal intents (but record so notifications/idempotence work).
  if (action.kind === "none") return { action, state: s };
  if (action.kind === "stop" || action.kind === "pauseNotify") {
    return { action, state: { ...s, lastActionKind: action.kind } };
  }

  // Budget caps (apply once a run is active).
  const started = s.startedAt ?? now;
  if (s.iterations >= config.maxIterations) {
    return {
      action: { kind: "stop", reason: "max iterations reached" },
      state: { ...s, lastActionKind: "stop" },
    };
  }
  if (now - started >= config.maxWallClockMs) {
    return {
      action: { kind: "stop", reason: "wall-clock budget exhausted" },
      state: { ...s, lastActionKind: "stop" },
    };
  }

  // Loop detection: same situation + same action already taken, no progress.
  // api-error is exempt — it has its own retry budget + backoff and must not be cut short here.
  const digest = digestOf(signal);
  if (
    s.lastSignalDigest === digest &&
    s.lastActionKind === action.kind &&
    s.iterations > 0 &&
    ruleId !== "api-error"
  ) {
    return {
      action: { kind: "stop", reason: "no progress after repeated intervention" },
      state: { ...s, lastActionKind: "stop" },
    };
  }

  // API-error backoff + conservative cap.
  if (ruleId === "api-error" && action.kind === "nudge") {
    const policy = signal.pane.serverBusy ? config.retryBusy : config.retry;
    if (s.apiRetries >= policy.maxRetries) {
      return {
        action: { kind: "pauseNotify", reason: "API errors persisted past the retry budget" },
        state: { ...s, lastActionKind: "pauseNotify" },
      };
    }
    const wait = nextDelayMs(policy, s.apiRetries);
    if (s.lastNudgeAt !== undefined && now - s.lastNudgeAt < wait) {
      return { action: { kind: "none" }, state: s }; // still backing off
    }
    return {
      action,
      state: {
        ...s,
        startedAt: started,
        iterations: s.iterations + 1,
        apiRetries: s.apiRetries + 1,
        lastActionKind: action.kind,
        lastNudgeAt: now,
        cooldownUntil: now + config.cooldownMs,
        lastSignalDigest: digest,
      },
    };
  }

  // Recovery cap (conservative).
  if (action.kind === "recover" && s.recoveries >= config.maxRecoveryAttempts) {
    return {
      action: { kind: "pauseNotify", reason: "recovery did not unstick the agent" },
      state: { ...s, lastActionKind: "pauseNotify" },
    };
  }

  // Idle nudge cooldown.
  if (ruleId === "idle-unfinished" && s.cooldownUntil !== undefined && now < s.cooldownUntil) {
    return { action: { kind: "none" }, state: s };
  }

  // Execute nudge/recover: advance counters.
  return {
    action,
    state: {
      ...s,
      startedAt: started,
      iterations: s.iterations + 1,
      // This path is only reached for idle-unfinished / stuck-prompt (the
      // api-error rule returns earlier), i.e. the API error has cleared — so
      // reset the API retry budget; otherwise it erodes across unrelated incidents.
      apiRetries: 0,
      recoveries: action.kind === "recover" ? s.recoveries + 1 : 0,
      lastActionKind: action.kind,
      lastNudgeAt: now,
      cooldownUntil: now + config.cooldownMs,
      lastSignalDigest: digest,
    },
  };
}
