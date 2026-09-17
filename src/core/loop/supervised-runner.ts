import { isProviderTransientFailure } from "../agents/transient-failure.js";
import {
  buildLoopSupervisorFinalizationPrompt,
  buildLoopSupervisorPrompt,
  buildLoopSupervisorRevisionPrompt,
} from "../prompts/loop-supervisor.js";
import { reserveDelegationBudget } from "./delegation-budget.js";
import { inspectDelegationContinuation } from "./delegation-continuation.js";
import { recoverNonTerminalPullRequestDecisions } from "./final-summary-contract.js";
import {
  captureFinalSummaryFreshness,
  type FinalSummaryFreshness,
  readFreshSupervisorFinalSummary,
} from "./final-summary-freshness.js";
import { supervisorFinalStatusToRunStatus } from "./final-summary-recovery.js";
import { readIterationCheckpoint } from "./iteration-checkpoint.js";
import type { LoopGitInvocation, LoopRunCommandResult } from "./run.js";
import {
  type LoopSupervisorFinalSummary,
  type LoopWorkOrder,
  parseSupervisorFinalSummary,
  validateSupervisorFinalSummaryForWorkOrder,
} from "./work-order.js";

export type SupervisorDispatchRequest = {
  session: string;
  prompt: string;
  signal: AbortSignal;
  workOrder: LoopWorkOrder;
  timeoutMs?: number;
  contextReset?: "none" | "compact" | "clear";
  deferLeaseUntilConsumption?: boolean;
};

export type SupervisorDispatchResult = {
  status: number;
  stdout: string;
  stderr: string;
  finalSummaryRecovery?: "disabled";
};

export type LoopRepairDisposition = "bot-repairable" | "target-or-external-blocker";

export type LoopSupervisedRunResult = (
  | {
      status: "completed";
      summary: LoopSupervisorFinalSummary;
      output: string;
    }
  | {
      status: "blocked" | "cancelled";
      summary: LoopSupervisorFinalSummary;
      output: string;
    }
  | {
      status: "supervisor-failed" | "supervisor-timeout";
      summary: LoopSupervisorFinalSummary;
      output: string;
    }
  | {
      status: "dispatch-failed" | "dispatch-timeout" | "invalid-output";
      reason: string;
      output: string;
    }
) & {
  /** Machine-readable ownership for a failure produced by bot infrastructure. */
  repairDisposition?: LoopRepairDisposition;
  finalSummaryRecovery?: "disabled";
  finalSummaryFreshness?: FinalSummaryFreshness;
};

export type LoopSupervisedRunnerInput = {
  workOrder: LoopWorkOrder;
  supervisorSession: string;
  timeoutMs: number;
  resetBeforeWorkOrder?: "none" | "compact" | "clear";
  cancelSignal?: AbortSignal;
  transientDispatchMaxAttempts?: number;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  dispatch: (request: SupervisorDispatchRequest) => Promise<SupervisorDispatchResult>;
};

export type LoopSupervisorRevisionInput = LoopSupervisedRunnerInput & {
  failures: string[];
  attempt: number;
  maxAttempts: number;
  previousOutput: string;
};

type SupervisorPromptSequenceInput = LoopSupervisedRunnerInput & {
  prompt: string;
  finalSummaryFreshness?: FinalSummaryFreshness;
};

export async function runLoopSupervisedProjectAsync(
  input: LoopSupervisedRunnerInput,
): Promise<LoopSupervisedRunResult> {
  if (input.cancelSignal?.aborted) {
    return cancelledRunResult(input.workOrder, abortReason(input.cancelSignal));
  }
  const reservation = reserveDelegationBudget(input.workOrder, input.timeoutMs);
  if (!reservation.ok) return reservation;
  input = { ...input, timeoutMs: reservation.timeoutMs };
  const freshness = captureFinalSummaryFreshness(input.workOrder);
  const freshnessResult = freshness === undefined ? {} : { finalSummaryFreshness: freshness };
  const controller = new AbortController();
  const dispatch = runSupervisorDispatchSequence(input, controller.signal, freshness)
    .then((result): LoopSupervisedRunResult | TimedOutResult => result)
    .catch((err: unknown): LoopSupervisedRunResult => {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "dispatch-failed", reason: message, output: message };
    });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimedOutResult>((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort("loop supervisor work order timed out");
      resolve({ timedOut: true, reason: "loop supervisor work order timed out" });
    }, input.timeoutMs);
    timeoutId.unref();
  });

  const cancellation = createCancellationRace(input.workOrder, controller, input.cancelSignal);

  const result = await Promise.race([dispatch, timeout, cancellation.promise]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  cancellation.cleanup();

  if (isTimedOutResult(result)) {
    return {
      status: "dispatch-timeout",
      reason: result.reason,
      output: result.reason,
      ...freshnessResult,
    };
  }

  return { ...result, ...freshnessResult };
}

export async function runLoopSupervisorRevisionAsync(
  input: LoopSupervisorRevisionInput,
): Promise<LoopSupervisedRunResult> {
  if (input.cancelSignal?.aborted) {
    return cancelledRunResult(input.workOrder, abortReason(input.cancelSignal));
  }
  const reservation = reserveDelegationBudget(input.workOrder, input.timeoutMs, input.maxAttempts);
  if (!reservation.ok) return reservation;
  input = { ...input, ...reservation };
  const freshness = captureFinalSummaryFreshness(input.workOrder);
  const freshnessResult = freshness === undefined ? {} : { finalSummaryFreshness: freshness };
  const controller = new AbortController();
  const dispatch = runSupervisorRevisionSequence(input, controller.signal, freshness)
    .then((result): LoopSupervisedRunResult | TimedOutResult => result)
    .catch((err: unknown): LoopSupervisedRunResult => {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "dispatch-failed", reason: message, output: message };
    });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimedOutResult>((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort("loop supervisor revision timed out");
      resolve({ timedOut: true, reason: "loop supervisor revision timed out" });
    }, input.timeoutMs);
    timeoutId.unref();
  });

  const cancellation = createCancellationRace(input.workOrder, controller, input.cancelSignal);

  const result = await Promise.race([dispatch, timeout, cancellation.promise]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  cancellation.cleanup();

  if (isTimedOutResult(result)) {
    return {
      status: "dispatch-timeout",
      reason: result.reason,
      output: result.reason,
      ...freshnessResult,
    };
  }

  return { ...result, ...freshnessResult };
}

async function runSupervisorDispatchSequence(
  input: LoopSupervisedRunnerInput,
  signal: AbortSignal,
  freshness: FinalSummaryFreshness | undefined,
): Promise<LoopSupervisedRunResult> {
  return runSupervisorPromptSequence(
    {
      ...input,
      ...(freshness === undefined ? {} : { finalSummaryFreshness: freshness }),
      prompt: buildLoopSupervisorPrompt(input.workOrder),
    },
    signal,
  );
}

async function runSupervisorRevisionSequence(
  input: LoopSupervisorRevisionInput,
  signal: AbortSignal,
  freshness: FinalSummaryFreshness | undefined,
): Promise<LoopSupervisedRunResult> {
  return runSupervisorPromptSequence(
    {
      ...input,
      ...(freshness === undefined ? {} : { finalSummaryFreshness: freshness }),
      prompt: buildLoopSupervisorRevisionPrompt({
        workOrder: input.workOrder,
        failures: input.failures,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        previousOutput: input.previousOutput,
      }),
    },
    signal,
  );
}

async function runSupervisorPromptSequence(
  input: SupervisorPromptSequenceInput,
  signal: AbortSignal,
): Promise<LoopSupervisedRunResult> {
  let before = readIterationCheckpoint(input.workOrder);
  let first = await dispatchWithProviderTransientRetry(input, signal, {
    prompt: input.prompt,
    ...(input.resetBeforeWorkOrder !== undefined
      ? { contextReset: input.resetBeforeWorkOrder }
      : {}),
  });
  let firstParsed = parseDispatchOutput(first, input.workOrder, input.finalSummaryFreshness);
  while (firstParsed.status === "invalid-output" && firstParsed.reason === "missing-final-marker") {
    signal.throwIfAborted();
    const decision = inspectDelegationContinuation(input.workOrder, before, input.runGit);
    if (decision.kind === "finalize") break;
    if (decision.kind === "stop") {
      return {
        status: "dispatch-failed",
        reason: decision.reason,
        output: [firstParsed.output, decision.reason].join("\n"),
        repairDisposition: "target-or-external-blocker",
        finalSummaryRecovery: "disabled",
      };
    }
    const reservation = reserveDelegationBudget(
      input.workOrder,
      input.timeoutMs,
      undefined,
      decision.sequence,
      decision.fingerprint,
    );
    if (!reservation.ok)
      return { ...reservation, output: [firstParsed.output, reservation.output].join("\n") };
    input = { ...input, timeoutMs: reservation.timeoutMs };
    before = readIterationCheckpoint(input.workOrder);
    first = await dispatchWithProviderTransientRetry(input, signal, { prompt: input.prompt });
    firstParsed = parseDispatchOutput(first, input.workOrder, input.finalSummaryFreshness);
  }
  if (firstParsed.status !== "invalid-output") return firstParsed;

  const finalization = await dispatchWithProviderTransientRetry(input, signal, {
    prompt: buildLoopSupervisorFinalizationPrompt(input.workOrder, firstParsed.output),
  });
  const secondParsed = parseDispatchOutput(
    finalization,
    input.workOrder,
    input.finalSummaryFreshness,
  );
  if (secondParsed.status !== "invalid-output") return secondParsed;
  return {
    ...secondParsed,
    output: [firstParsed.output, secondParsed.output].filter(Boolean).join("\n"),
  };
}

async function dispatchWithProviderTransientRetry(
  input: SupervisorPromptSequenceInput,
  signal: AbortSignal,
  request: { prompt: string; contextReset?: SupervisorDispatchRequest["contextReset"] },
): Promise<SupervisorDispatchResult> {
  const maxAttempts = Math.max(1, input.transientDispatchMaxAttempts ?? 2);
  let last: SupervisorDispatchResult | undefined;
  let lastTransientOutput: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal.throwIfAborted();
    try {
      const result = await input.dispatch({
        session: input.supervisorSession,
        prompt: request.prompt,
        signal,
        workOrder: input.workOrder,
        timeoutMs: input.timeoutMs,
        ...(request.contextReset !== undefined ? { contextReset: request.contextReset } : {}),
      });
      signal.throwIfAborted();
      last = result;
      if (result.finalSummaryRecovery === "disabled") return result;
      const output = joinOutput(result);
      if (!isProviderTransientFailure(output)) return result;
      lastTransientOutput = output;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      last = { status: 1, stdout: "", stderr: message };
      lastTransientOutput = message;
      if (!isProviderTransientFailure(message)) throw err;
    }
    if (signal.aborted) return last;
  }
  if (last !== undefined && last.status === 0 && lastTransientOutput !== undefined) {
    return { status: 1, stdout: "", stderr: lastTransientOutput };
  }
  return last ?? { status: 1, stdout: "", stderr: "dispatch failed" };
}

function parseDispatchOutput(
  result: SupervisorDispatchResult,
  workOrder: LoopWorkOrder,
  freshness: FinalSummaryFreshness | undefined,
): LoopSupervisedRunResult {
  const output = joinOutput(result);
  if (result.finalSummaryRecovery === "disabled") {
    return {
      status: "dispatch-failed",
      reason: result.stderr || "dispatch ownership unavailable",
      output,
      finalSummaryRecovery: "disabled",
    };
  }
  if (result.status !== 0) {
    return { status: "dispatch-failed", reason: result.stderr || "dispatch failed", output };
  }
  if (isAgentNotRunningOutput(output)) {
    return {
      status: "dispatch-failed",
      reason: "no live loop supervisor session",
      output,
      repairDisposition: "bot-repairable",
    };
  }
  const fileParsed = readFreshSupervisorFinalSummary(workOrder, freshness);
  const parsed = fileParsed.ok ? fileParsed : parseSupervisorFinalSummary(output, workOrder.id);
  if (!parsed.ok) {
    return invalidSupervisorOutput(parsed.reason, output);
  }
  const summary = recoverNonTerminalPullRequestDecisions(workOrder, parsed.summary);
  if (!validateSupervisorFinalSummaryForWorkOrder(workOrder, summary)) {
    return invalidSupervisorOutput("invalid-summary", output);
  }

  return {
    status: supervisorFinalStatusToRunStatus(summary.status),
    summary,
    output,
  };
}

function invalidSupervisorOutput(reason: string, output: string): LoopSupervisedRunResult {
  return { status: "invalid-output", reason, output, repairDisposition: "bot-repairable" };
}

function joinOutput(result: SupervisorDispatchResult): string {
  return [result.stdout, result.stderr].filter((text) => text.length > 0).join("\n");
}

function isAgentNotRunningOutput(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    (normalized.includes("not running") &&
      normalized.includes("/resume") &&
      normalized.includes("/start")) ||
    (output.includes("未运行") && output.includes("/resume") && output.includes("/start")) ||
    (output.includes("未執行") && output.includes("/resume") && output.includes("/start")) ||
    (output.includes("実行されていません") &&
      output.includes("/resume") &&
      output.includes("/start")) ||
    (normalized.includes("no está en ejecución") &&
      normalized.includes("/resume") &&
      normalized.includes("/start"))
  );
}

type TimedOutResult = {
  timedOut: true;
  reason: string;
};

function isTimedOutResult(
  result: LoopSupervisedRunResult | TimedOutResult,
): result is TimedOutResult {
  return "timedOut" in result;
}

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === "string" ? signal.reason : "loop supervisor work order cancelled";
}

function createCancellationRace(
  workOrder: LoopWorkOrder,
  controller: AbortController,
  signal: AbortSignal | undefined,
): { promise: Promise<LoopSupervisedRunResult>; cleanup: () => void } {
  let cancelListener: (() => void) | undefined;
  const promise = new Promise<LoopSupervisedRunResult>((resolve) => {
    if (signal === undefined) return;
    cancelListener = () => {
      const reason = abortReason(signal);
      controller.abort(reason);
      resolve(cancelledRunResult(workOrder, reason));
    };
    signal.addEventListener("abort", cancelListener, { once: true });
  });
  return {
    promise,
    cleanup: () => {
      if (cancelListener !== undefined) signal?.removeEventListener("abort", cancelListener);
    },
  };
}

function cancelledRunResult(workOrder: LoopWorkOrder, reason: string): LoopSupervisedRunResult {
  return {
    status: "cancelled",
    summary: {
      status: "cancelled",
      projectId: workOrder.projectId,
      actionsTaken: [reason],
      delegatedTasks: [],
      finalVerification: "not-run",
      commits: [],
      followUps: [],
    },
    output: reason,
  };
}
