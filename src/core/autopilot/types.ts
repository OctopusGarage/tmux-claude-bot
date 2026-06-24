export type AutopilotPersona = "conservative" | "aggressive";

export type PaneSemantics = {
  inputPromptWaiting: boolean;
  apiError: boolean;
  /** Subset of apiError: HTTP 4xx/5xx overloads, rate limits, and service-unavailable
   * messages that warrant a much longer backoff than a plain transient connection blip. */
  serverBusy: boolean;
  hardStop: boolean;
};

export type SessionSignal = {
  session: string;
  busy: boolean;
  idleForMs: number; // ms since last activity/nudge; Number.POSITIVE_INFINITY if unknown
  queueEmpty: boolean; // no queued or in-flight work for this session
  turnFinished: boolean; // last transcript round looks self-contained (not mid-stream)
  pane: PaneSemantics;
  progressAt: number; // epoch ms of latest agent activity; 0 when unknown
  sentinels: string[]; // [MARKER] tokens from the agent's latest transcript round (NOT the pane — it echoes injected prompts)
};

export type Action =
  | { kind: "none" }
  | { kind: "nudge"; text: string }
  | { kind: "recover" }
  | { kind: "pauseNotify"; reason: string }
  | { kind: "stop"; reason: string };

export type Decision = { ruleId: string; action: Action };

export type AutopilotState = {
  enabled: boolean;
  pureKeepAlive: boolean; // nudge even with no active goal (Phase 1 has no goals → this is the only nudge source)
  persona: AutopilotPersona;
  iterations: number; // nudges + recoveries this run (governor cap)
  apiRetries: number; // consecutive api-error nudges (backoff + cap)
  recoveries: number; // consecutive recovery escalations
  startedAt?: number; // run start (wall-clock budget)
  lastActionKind?: string;
  lastNudgeAt?: number;
  cooldownUntil?: number;
  lastSignalDigest?: string; // loop-detection: same signal + same action repeated
  goalId?: string;
  phaseIndex?: number; // 0-based; undefined ⇒ no goal
  seqIndex?: number; // progress within a `seq` done condition
  humanGatePending?: boolean;
  humanConfirmed?: boolean;
  reworkPending?: boolean; // user rejected the gate ("keep going") → re-prompt the agent next tick
  goalIterations?: number; // intent injections this goal (separate from keep-alive iterations)
  goalQueue?: string[]; // ordered goal ids for a cycle; active goal = goalQueue[queuePos]
  rounds?: number; // how many times to cycle the whole queue (>=1)
  queuePos?: number; // index of the active goal within goalQueue
  roundsDone?: number; // completed full cycles
  pendingContextOp?: "compact" | "clear"; // op to run before the next goal's first prompt; cleared once sent
  // Ownership flags. viaGlobal and viaScheduler are mutually-exclusive enrollment
  // sources; if a third owner ever appears, collapse these into a single
  // `owner?: "global" | "scheduler"` enum rather than adding another boolean + guards.
  optOut?: boolean; // user ran `/autopilot off` → global keep-alive won't auto-enroll this session
  viaGlobal?: boolean; // auto-enrolled by global keep-alive (so global-off can un-enroll it)
  viaScheduler?: boolean; // owned by the batch scheduler → global keep-alive must not enroll/touch it
};

export type GoalOutcome =
  | { kind: "inject"; text: string; nextState: AutopilotState }
  | { kind: "advance"; nextState: AutopilotState }
  | { kind: "finalize"; reason: string; nextState: AutopilotState }
  | { kind: "awaitHuman"; reason: string; nextState: AutopilotState }
  | { kind: "none" };

export type AutopilotRuntimeConfig = import("../../shared/types.js").AutopilotRuntimeConfig;

export type RuleContext = {
  state: AutopilotState;
  config: AutopilotRuntimeConfig;
  now: number;
};

export type Rule = {
  id: string;
  when: (s: SessionSignal, ctx: RuleContext) => boolean;
  act: (s: SessionSignal, ctx: RuleContext) => Action;
};

export function defaultState(persona: AutopilotPersona = "conservative"): AutopilotState {
  return {
    enabled: false,
    pureKeepAlive: false,
    persona,
    iterations: 0,
    apiRetries: 0,
    recoveries: 0,
  };
}
