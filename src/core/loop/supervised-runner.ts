import {
  buildLoopSupervisorPrompt,
  type LoopSupervisorFinalSummary,
  type LoopWorkOrder,
  parseSupervisorFinalSummary,
} from "./work-order.js";

export type SupervisorDispatchRequest = {
  session: string;
  prompt: string;
  signal: AbortSignal;
  workOrder: LoopWorkOrder;
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
  dispatch: (request: SupervisorDispatchRequest) => Promise<SupervisorDispatchResult>;
};

export async function runLoopSupervisedProjectAsync(
  input: LoopSupervisedRunnerInput,
): Promise<LoopSupervisedRunResult> {
  const prompt = buildLoopSupervisorPrompt(input.workOrder);
  const controller = new AbortController();
  const dispatch = Promise.resolve()
    .then(() =>
      input.dispatch({
        session: input.supervisorSession,
        prompt,
        signal: controller.signal,
        workOrder: input.workOrder,
      }),
    )
    .then((result): SupervisorDispatchResult | TimedOutResult => result)
    .catch((err: unknown): SupervisorDispatchResult => {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 1, stdout: "", stderr: message };
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

  const output = joinOutput(result);
  if (result.status !== 0) {
    return { status: "dispatch-failed", reason: result.stderr || "dispatch failed", output };
  }

  const parsed = parseSupervisorFinalSummary(output, input.workOrder.id);
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
  result: SupervisorDispatchResult | TimedOutResult,
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
