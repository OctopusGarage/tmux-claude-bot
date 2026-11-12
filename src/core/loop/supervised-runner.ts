import { isProviderTransientFailure } from "../agents/transient-failure.js";
import {
  buildLoopSupervisorFinalizationPrompt,
  buildLoopSupervisorPrompt,
  buildLoopSupervisorRevisionPrompt,
} from "../prompts/loop-supervisor.js";
import { reserveDelegationBudget } from "./delegation-budget.js";
import { inspectDelegationContinuation } from "./delegation-continuation.js";
import { hasLoopExecutionQuarantine } from "./execution-quarantine.js";
import { recoverNonTerminalPullRequestDecisions } from "./final-summary-contract.js";
import {
  captureFinalSummaryFreshness,
  type FinalSummaryFreshness,
  readFreshSupervisorFinalSummary,
} from "./final-summary-freshness.js";
import { supervisorFinalStatusToRunStatus } from "./final-summary-recovery.js";
import { readIterationCheckpoint } from "./iteration-checkpoint.js";
import {
  hasRalphPrReviewer,
  ralphPrReviewDeadline,
  reserveRalphPrReviewDeadline,
} from "./ralph-pr-review.js";
import {
  executeRalphTask,
  hasRalphTask,
  RalphTaskStoppedError,
  readRalphTaskEvidence,
} from "./ralph-task.js";
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
  authorityFence?: () => void;
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
  executionOwnership?: "quarantined";
};

export type LoopSupervisedRunnerInput = {
  workOrder: LoopWorkOrder;
  supervisorSession: string;
  timeoutMs: number;
  deadline?: number;
  resetBeforeWorkOrder?: "none" | "compact" | "clear";
  cancelSignal?: AbortSignal;
  transientDispatchMaxAttempts?: number;
  runGit?: (invocation: LoopGitInvocation) => LoopRunCommandResult;
  dispatch: (request: SupervisorDispatchRequest) => Promise<SupervisorDispatchResult>;
  executeTask?: typeof executeRalphTask;
  onExternalExecutionStarted?: () => void;
  recoverDispatchReadiness?: (failure: LoopSupervisedRunResult) => Promise<boolean>;
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

class ExternalReviewDeadlineError extends Error {}

export async function runLoopSupervisedProjectAsync(
  input: LoopSupervisedRunnerInput,
): Promise<LoopSupervisedRunResult> {
  if (input.cancelSignal?.aborted) {
    return cancelledRunResult(input.workOrder, abortReason(input.cancelSignal));
  }
  if (hasRalphPrReviewer(input.workOrder)) {
    try {
      reserveRalphPrReviewDeadline(input.workOrder, input.timeoutMs, input.deadline);
      input = {
        ...input,
        deadline: ralphPrReviewDeadline(input.workOrder),
        timeoutMs: Math.min(input.timeoutMs, ralphPrReviewDeadline(input.workOrder) - Date.now()),
      };
    } catch {
      return externalDeadlineExhausted();
    }
  }
  if (hasRalphTask(input.workOrder)) {
    const deadline = input.deadline ?? Date.now() + input.timeoutMs;
    input = { ...input, deadline, timeoutMs: Math.min(input.timeoutMs, deadline - Date.now()) };
    if (input.timeoutMs <= 0) return externalDeadlineExhausted();
  }
  const reservation = reserveDelegationBudget(input.workOrder, input.timeoutMs);
  if (!reservation.ok) return reservation;
  input = { ...input, timeoutMs: reservation.timeoutMs };
  if (hasRalphTask(input.workOrder)) {
    const startedAt = Date.now();
    try {
      // Await the subprocess owner's bounded stop; do not race it against lease release.
      await (input.executeTask ?? executeRalphTask)({
        workOrder: input.workOrder,
        timeoutMs: Math.max(1, Math.floor(input.timeoutMs * 0.8)),
        signal: input.cancelSignal ?? new AbortController().signal,
        ...(input.onExternalExecutionStarted
          ? { onStarted: input.onExternalExecutionStarted }
          : {}),
      });
      if (input.cancelSignal?.aborted)
        return {
          ...cancelledRunResult(input.workOrder, abortReason(input.cancelSignal)),
          finalSummaryRecovery: "disabled",
        };
      input = { ...input, timeoutMs: input.timeoutMs - (Date.now() - startedAt) };
      if (input.timeoutMs <= 0) return externalDeadlineExhausted();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "RalphWorks execution failed";
      const ownership = hasLoopExecutionQuarantine(input.workOrder.id)
        ? { executionOwnership: "quarantined" as const }
        : {};
      if (input.cancelSignal?.aborted || error instanceof RalphTaskStoppedError) {
        if (
          !input.cancelSignal?.aborted &&
          error instanceof RalphTaskStoppedError &&
          error.reason === "timed_out"
        ) {
          return {
            status: "dispatch-timeout",
            reason,
            output: reason,
            finalSummaryRecovery: "disabled",
            ...ownership,
          };
        }
        return {
          ...cancelledRunResult(input.workOrder, reason),
          finalSummaryRecovery: "disabled",
          ...ownership,
        };
      }
      return {
        status: "dispatch-failed",
        reason,
        output: reason,
        finalSummaryRecovery: "disabled",
        repairDisposition: "target-or-external-blocker",
        ...(hasLoopExecutionQuarantine(input.workOrder.id)
          ? { executionOwnership: "quarantined" as const }
          : {}),
      };
    }
  }
  const freshness = captureFinalSummaryFreshness(input.workOrder);
  const freshnessResult = freshness === undefined ? {} : { finalSummaryFreshness: freshness };
  const controller = new AbortController();
  const dispatch = runSupervisorDispatchSequence(input, controller.signal, freshness)
    .then((result): LoopSupervisedRunResult | TimedOutResult => result)
    .catch((err: unknown): LoopSupervisedRunResult => {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: err instanceof ExternalReviewDeadlineError ? "dispatch-timeout" : "dispatch-failed",
        reason: message,
        output: message,
        ...(err instanceof ExternalReviewDeadlineError
          ? { finalSummaryRecovery: "disabled" as const }
          : {}),
      };
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
      ...(hasRalphTask(input.workOrder) || hasRalphPrReviewer(input.workOrder)
        ? { finalSummaryRecovery: "disabled" as const }
        : {}),
    };
  }

  return { ...result, ...freshnessResult };
}

export async function runLoopSupervisorRevisionAsync(
  input: LoopSupervisorRevisionInput,
): Promise<LoopSupervisedRunResult> {
  if (hasRalphPrReviewer(input.workOrder)) {
    try {
      const deadline = ralphPrReviewDeadline(input.workOrder);
      input = { ...input, deadline, timeoutMs: Math.min(input.timeoutMs, deadline - Date.now()) };
      if (input.timeoutMs <= 0) return externalDeadlineExhausted();
    } catch {
      return externalDeadlineExhausted();
    }
  }
  if (input.cancelSignal?.aborted) {
    return cancelledRunResult(input.workOrder, abortReason(input.cancelSignal));
  }
  if (hasRalphTask(input.workOrder)) {
    const deadline = input.deadline ?? Date.now() + input.timeoutMs;
    input = { ...input, deadline, timeoutMs: Math.min(input.timeoutMs, deadline - Date.now()) };
    if (input.timeoutMs <= 0) return externalDeadlineExhausted();
    try {
      readRalphTaskEvidence(input.workOrder);
    } catch {
      return {
        status: "dispatch-failed",
        reason: "RalphWorks review revision requires intact execution evidence",
        output: "RalphWorks review revision requires intact execution evidence",
        finalSummaryRecovery: "disabled",
      };
    }
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
      return {
        status: err instanceof ExternalReviewDeadlineError ? "dispatch-timeout" : "dispatch-failed",
        reason: message,
        output: message,
        ...(err instanceof ExternalReviewDeadlineError
          ? { finalSummaryRecovery: "disabled" as const }
          : {}),
      };
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
      ...(hasRalphTask(input.workOrder) || hasRalphPrReviewer(input.workOrder)
        ? { finalSummaryRecovery: "disabled" as const }
        : {}),
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
  if (hasRalphTask(input.workOrder))
    input = { ...input, deadline: input.deadline ?? Date.now() + input.timeoutMs };
  let before = readIterationCheckpoint(input.workOrder);
  let first = await dispatchWithProviderTransientRetry(input, signal, {
    prompt: input.prompt,
    ...(input.resetBeforeWorkOrder !== undefined
      ? { contextReset: input.resetBeforeWorkOrder }
      : {}),
  });
  let firstParsed = parseDispatchOutput(first, input.workOrder, input.finalSummaryFreshness);
  if (
    hasRalphTask(input.workOrder) &&
    input.recoverDispatchReadiness !== undefined &&
    firstParsed.status === "dispatch-failed" &&
    firstParsed.finalSummaryRecovery !== "disabled"
  ) {
    const assertSafeReviewRetry = () => {
      signal.throwIfAborted();
      if (input.deadline !== undefined && Date.now() >= input.deadline)
        throw new ExternalReviewDeadlineError("External review exhausted the WorkOrder deadline");
      if (hasLoopExecutionQuarantine(input.workOrder.id))
        throw new Error("RalphWorks review ownership is quarantined");
      readRalphTaskEvidence(input.workOrder);
    };
    try {
      assertSafeReviewRetry();
      if (await input.recoverDispatchReadiness(firstParsed)) {
        assertSafeReviewRetry();
        first = await dispatchWithProviderTransientRetry(input, signal, { prompt: input.prompt });
        firstParsed = parseDispatchOutput(first, input.workOrder, input.finalSummaryFreshness);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof ExternalReviewDeadlineError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      return {
        status: "dispatch-failed",
        reason,
        output: reason,
        finalSummaryRecovery: "disabled",
        ...(hasLoopExecutionQuarantine(input.workOrder.id)
          ? { executionOwnership: "quarantined" as const }
          : {}),
      };
    }
  }
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

function externalDeadlineExhausted(): LoopSupervisedRunResult {
  const reason = "External review exhausted the WorkOrder deadline";
  return { status: "dispatch-timeout", reason, output: reason, finalSummaryRecovery: "disabled" };
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
    const remaining =
      input.deadline === undefined
        ? input.timeoutMs
        : Math.min(input.timeoutMs, input.deadline - Date.now());
    if (input.deadline !== undefined && remaining <= 0)
      throw new ExternalReviewDeadlineError("External review exhausted the WorkOrder deadline");
    if (remaining <= 0) throw new Error("External review exhausted the WorkOrder deadline");
    try {
      const result = await input.dispatch({
        session: input.supervisorSession,
        prompt:
          input.deadline === undefined
            ? request.prompt
            : [
                request.prompt,
                "",
                `Review hard deadline (UTC): ${new Date(input.deadline).toISOString()}`,
                `Remaining review budget at dispatch: ${remaining} milliseconds, including final summary, commit and system-gate handoff.`,
                "Use this remaining budget rather than the original WorkOrder timeout. Recompute it before long commands; no retry or continuation extends the deadline.",
              ].join("\n"),
        signal,
        workOrder: input.workOrder,
        timeoutMs: remaining,
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
    if (isAgentStartupFailureOutput(output)) {
      return {
        status: "dispatch-failed",
        reason: "agent startup reported authentication, MCP, or hook initialization failure",
        output,
        repairDisposition: "bot-repairable",
      };
    }
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

export function isAgentStartupFailureOutput(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("access token could not be refreshed") ||
    (normalized.includes("unexpected status 401") &&
      normalized.includes("incorrect api key provided") &&
      normalized.includes("backend-api/codex/responses")) ||
    normalized.includes("mcp startup incomplete") ||
    (normalized.includes("hook failed") && normalized.includes("hook exited with code"))
  );
}

export function isAgentStartupFailureResult(result: LoopSupervisedRunResult): boolean {
  if (result.status !== "dispatch-failed") return false;
  return isAgentStartupFailureOutput(`${result.reason}\n${result.output}`);
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
