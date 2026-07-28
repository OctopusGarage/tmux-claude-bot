import {
  buildLoopSupervisorFinalizationPrompt,
  buildLoopSupervisorPrompt,
  buildLoopSupervisorRevisionPrompt,
  type LoopSupervisorFinalSummary,
  type LoopWorkOrder,
  parseSupervisorFinalSummary,
  parseSupervisorFinalSummaryFile,
} from "./work-order.js";

export type SupervisorDispatchRequest = {
  session: string;
  prompt: string;
  signal: AbortSignal;
  workOrder: LoopWorkOrder;
  contextReset?: "none" | "compact" | "clear";
};

export type SupervisorDispatchResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type LoopSupervisedRunResult =
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
    };

export type LoopSupervisedRunnerInput = {
  workOrder: LoopWorkOrder;
  supervisorSession: string;
  timeoutMs: number;
  resetBeforeWorkOrder?: "none" | "compact" | "clear";
  dispatch: (request: SupervisorDispatchRequest) => Promise<SupervisorDispatchResult>;
};

export type LoopSupervisorRevisionInput = LoopSupervisedRunnerInput & {
  failures: string[];
  attempt: number;
  maxAttempts: number;
  previousOutput: string;
};

export async function runLoopSupervisedProjectAsync(
  input: LoopSupervisedRunnerInput,
): Promise<LoopSupervisedRunResult> {
  const controller = new AbortController();
  const dispatch = runSupervisorDispatchSequence(input, controller.signal)
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
    timeoutId.unref?.();
  });

  const result = await Promise.race([dispatch, timeout]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);

  if (isTimedOutResult(result)) {
    return { status: "dispatch-timeout", reason: result.reason, output: result.reason };
  }

  return result;
}

export async function runLoopSupervisorRevisionAsync(
  input: LoopSupervisorRevisionInput,
): Promise<LoopSupervisedRunResult> {
  const controller = new AbortController();
  const dispatch = runSupervisorRevisionSequence(input, controller.signal)
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
    timeoutId.unref?.();
  });

  const result = await Promise.race([dispatch, timeout]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);

  if (isTimedOutResult(result)) {
    return { status: "dispatch-timeout", reason: result.reason, output: result.reason };
  }

  return result;
}

async function runSupervisorDispatchSequence(
  input: LoopSupervisedRunnerInput,
  signal: AbortSignal,
): Promise<LoopSupervisedRunResult> {
  const first = await input.dispatch({
    session: input.supervisorSession,
    prompt: buildLoopSupervisorPrompt(input.workOrder),
    signal,
    workOrder: input.workOrder,
    ...(input.resetBeforeWorkOrder !== undefined
      ? { contextReset: input.resetBeforeWorkOrder }
      : {}),
  });
  const firstParsed = parseDispatchOutput(first, input.workOrder);
  if (firstParsed.status !== "invalid-output") {
    return firstParsed;
  }

  const finalization = await input.dispatch({
    session: input.supervisorSession,
    prompt: buildLoopSupervisorFinalizationPrompt(input.workOrder, firstParsed.output),
    signal,
    workOrder: input.workOrder,
  });
  const secondParsed = parseDispatchOutput(finalization, input.workOrder);
  if (secondParsed.status !== "invalid-output") return secondParsed;
  return {
    ...secondParsed,
    output: [firstParsed.output, secondParsed.output].filter(Boolean).join("\n"),
  };
}

async function runSupervisorRevisionSequence(
  input: LoopSupervisorRevisionInput,
  signal: AbortSignal,
): Promise<LoopSupervisedRunResult> {
  const first = await input.dispatch({
    session: input.supervisorSession,
    prompt: buildLoopSupervisorRevisionPrompt({
      workOrder: input.workOrder,
      failures: input.failures,
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      previousOutput: input.previousOutput,
    }),
    signal,
    workOrder: input.workOrder,
  });
  const firstParsed = parseDispatchOutput(first, input.workOrder);
  if (firstParsed.status !== "invalid-output") {
    return firstParsed;
  }

  const finalization = await input.dispatch({
    session: input.supervisorSession,
    prompt: buildLoopSupervisorFinalizationPrompt(input.workOrder, firstParsed.output),
    signal,
    workOrder: input.workOrder,
  });
  const secondParsed = parseDispatchOutput(finalization, input.workOrder);
  if (secondParsed.status !== "invalid-output") return secondParsed;
  return {
    ...secondParsed,
    output: [firstParsed.output, secondParsed.output].filter(Boolean).join("\n"),
  };
}

function parseDispatchOutput(
  result: SupervisorDispatchResult,
  workOrder: LoopWorkOrder,
): LoopSupervisedRunResult {
  const output = joinOutput(result);
  if (result.status !== 0) {
    return { status: "dispatch-failed", reason: result.stderr || "dispatch failed", output };
  }
  const fileParsed = parseSupervisorFinalSummaryFile(workOrder);
  const parsed = fileParsed.ok ? fileParsed : parseSupervisorFinalSummary(output, workOrder.id);
  if (!parsed.ok) {
    return { status: "invalid-output", reason: parsed.reason, output };
  }

  return { status: mapSupervisorStatus(parsed.summary.status), summary: parsed.summary, output };
}

function joinOutput(result: SupervisorDispatchResult): string {
  return [result.stdout, result.stderr].filter((text) => text.length > 0).join("\n");
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

function mapSupervisorStatus(
  status: LoopSupervisorFinalSummary["status"],
): Exclude<
  LoopSupervisedRunResult["status"],
  "dispatch-failed" | "dispatch-timeout" | "invalid-output"
> {
  if (status === "failed") return "supervisor-failed";
  if (status === "timeout") return "supervisor-timeout";
  return status;
}
