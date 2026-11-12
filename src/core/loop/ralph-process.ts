import { spawn } from "node:child_process";
import { constants } from "node:os";
import { getSystemErrorMap } from "node:util";
import { createLogger } from "../../shared/utils/logger.js";
import {
  createProcessIdentityProbe,
  type ProcessIdentity,
  ResourceProcessProbeTimeoutError,
  sameProcessInstance,
} from "../resource-guardian/ownership.js";
import type { LoopRunCommandResult } from "./run.js";

const log = createLogger("loop.ralph-process");

export class RalphProcessOwnershipError extends Error {
  override name = "RalphProcessOwnershipError";

  constructor(
    message: string,
    readonly diagnostic?: OwnershipSnapshotDiagnostic,
    readonly confirmedProbeTimeout = false,
  ) {
    super(message);
  }
}

type OwnershipSnapshotDiagnostic = {
  stage: "process-probe" | "ownership-persistence";
  errorName: string;
  code: string | number | null;
  killed: boolean | null;
  signal: string | null;
  elapsedMs: number;
};

const SAFE_ERROR_NAMES = new Set([
  "Error",
  "ResourceProcessProbeTimeoutError",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "SystemError",
]);
const SAFE_ERROR_CODES = new Set([
  ...[...getSystemErrorMap().values()].map(([name]) => name),
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  "ERR_OUT_OF_RANGE",
  "ERR_INVALID_ARG_TYPE",
  "ABORT_ERR",
]);

function snapshotFailure(
  stage: OwnershipSnapshotDiagnostic["stage"],
  error: unknown,
  startedAt: number,
): RalphProcessOwnershipError {
  const fields =
    error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const elapsedMs = Math.max(0, performance.now() - startedAt);
  const diagnostic: OwnershipSnapshotDiagnostic = {
    stage,
    errorName:
      typeof fields.name === "string" && SAFE_ERROR_NAMES.has(fields.name)
        ? fields.name
        : "UnknownError",
    code:
      typeof fields.code === "string" && SAFE_ERROR_CODES.has(fields.code)
        ? fields.code
        : typeof fields.code === "number" &&
            Number.isInteger(fields.code) &&
            fields.code >= 0 &&
            fields.code <= 255
          ? fields.code
          : null,
    killed: typeof fields.killed === "boolean" ? fields.killed : null,
    signal:
      typeof fields.signal === "string" && Object.hasOwn(constants.signals, fields.signal)
        ? fields.signal
        : null,
    elapsedMs: Math.round(elapsedMs),
  };
  const detail = Object.entries(diagnostic)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return new RalphProcessOwnershipError(
    `RalphWorks process ownership snapshot failed (${detail})`,
    diagnostic,
    stage === "process-probe" && error instanceof ResourceProcessProbeTimeoutError,
  );
}

export type RalphProcessResult = LoopRunCommandResult & {
  stopped?: { reason: "cancelled" | "timed_out"; knownProcessesStopped: true };
  ownershipProbeRetries?: { count: number; lastTimeout: OwnershipSnapshotDiagnostic };
};

/** Stop only exact launched/descendant identities, including detached tool groups. */
export function runRalphProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  onOwnedProcesses?: (processes: ProcessIdentity[]) => void;
}): Promise<RalphProcessResult> {
  input.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const probe = createProcessIdentityProbe({});
    const owned = new Map<number, ProcessIdentity>();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let stopReason: "cancelled" | "timed_out" | undefined;
    let closed = false;
    let exited = false;
    let stopEnded = false;
    let stopDeadline: number | undefined;
    let resolveClosed!: () => void;
    const childClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let exitStatus = 1;
    let scan: Promise<ProcessIdentity[]> | undefined;
    let stopping: Promise<void> | undefined;
    let settled = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let consecutiveProbeTimeouts = 0;
    let ownershipProbeRetries: RalphProcessResult["ownershipProbeRetries"];
    const snapshotOnce = (): Promise<ProcessIdentity[]> => {
      const exitedAtStart = exited;
      const closedAtStart = closed;
      const probeStartedAt = performance.now();
      return probe(stopDeadline === undefined ? undefined : Math.max(1, stopDeadline - Date.now()))
        .catch((error: unknown) => {
          throw snapshotFailure("process-probe", error, probeStartedAt);
        })
        .then(({ processes }) => {
          if (settled || stopEnded) return [];
          if (stopDeadline !== undefined && Date.now() >= stopDeadline)
            throw new RalphProcessOwnershipError(
              "RalphWorks process termination could not be verified; retain execution ownership",
            );
          // Exit and close each invalidate a table captured in the prior phase.
          // Refresh serially before either positive or negative ownership inference.
          if (exitedAtStart !== exited || closedAtStart !== closed) return snapshotOnce();
          const current = new Map(processes.map((entry) => [entry.pid, entry]));
          const previousCount = owned.size;
          const root = child.pid === undefined ? undefined : current.get(child.pid);
          if (root !== undefined && !exited && !closed && !owned.has(root.pid))
            owned.set(root.pid, root);
          let changed = true;
          while (changed) {
            changed = false;
            for (const process of processes) {
              if (owned.has(process.pid)) continue;
              const parent = owned.get(process.ppid);
              const currentParent = current.get(process.ppid);
              if (
                parent !== undefined &&
                currentParent !== undefined &&
                sameProcessInstance(parent, currentParent)
              ) {
                owned.set(process.pid, process);
                changed = true;
              }
            }
          }
          if (owned.size !== previousCount) {
            const persistenceStartedAt = performance.now();
            try {
              input.onOwnedProcesses?.([...owned.values()]);
            } catch (error) {
              throw snapshotFailure("ownership-persistence", error, persistenceStartedAt);
            }
          }
          // A group number cannot authorize signalling an unobserved process.
          // It can reveal that a filtered-empty table is insufficient stop proof.
          if (
            (stopping !== undefined || closed) &&
            process.platform !== "win32" &&
            processes.some((entry) => {
              if (entry.pgid !== child.pid) return false;
              const expected = owned.get(entry.pid);
              return expected === undefined || !sameProcessInstance(expected, entry);
            }) &&
            !(failure instanceof RalphProcessOwnershipError)
          )
            failure = new RalphProcessOwnershipError(
              "RalphWorks launched group contains an unverified process; retain execution ownership",
            );
          return processes.filter((process) => {
            const expected = owned.get(process.pid);
            return expected !== undefined && sameProcessInstance(expected, process);
          });
        });
    };
    const snapshot = (): Promise<ProcessIdentity[]> => {
      if (scan !== undefined) return scan;
      scan = snapshotOnce()
        .catch((error: unknown) => {
          if (
            !settled &&
            stopping === undefined &&
            failure === undefined &&
            (!closed || exitStatus === 0) &&
            !input.signal.aborted &&
            Date.now() < executionDeadline &&
            consecutiveProbeTimeouts === 0 &&
            error instanceof RalphProcessOwnershipError &&
            error.confirmedProbeTimeout &&
            error.diagnostic !== undefined
          ) {
            consecutiveProbeTimeouts = 1;
            ownershipProbeRetries = {
              count: (ownershipProbeRetries?.count ?? 0) + 1,
              lastTimeout: error.diagnostic,
            };
            log.warn("RalphWorks ownership probe timed out; retrying once", {
              data: { retryCount: ownershipProbeRetries.count, ...error.diagnostic },
            });
            return snapshotOnce();
          }
          throw error;
        })
        .then((processes) => {
          consecutiveProbeTimeouts = 0;
          return processes;
        })
        .finally(() => {
          scan = undefined;
        });
      return scan;
    };
    const signalProcesses = (processes: ProcessIdentity[], signal: NodeJS.Signals): void => {
      // Children first, while parents can still reap them. Never match command names.
      for (const process of [...processes].reverse()) {
        if (settled || stopEnded) return;
        if (process.pid === child.pid) continue;
        try {
          globalThis.process.kill(process.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            failure ??= new Error("RalphWorks process stop failed");
        }
      }
    };
    const signalRoot = (signal: NodeJS.Signals): boolean => {
      // The original live handle is a capability; a remembered PID/group is not.
      if (exited || closed) return false;
      try {
        return child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          failure ??= new Error("RalphWorks direct process stop failed");
        return false;
      }
    };
    const finish = async (): Promise<void> => {
      if (settled || !closed) return;
      if (stopping !== undefined) await stopping;
      else {
        // Normal CLI exit must also drain detached children before returning.
        const remaining = await snapshot();
        if (remaining.length > 0) await stopOwned();
      }
      if (stopReason === undefined && (input.signal.aborted || Date.now() >= executionDeadline)) {
        stop(
          input.signal.aborted
            ? "RalphWorks execution cancelled"
            : "RalphWorks execution timed out",
        );
      }
      if (stopping !== undefined) await stopping;
      // Concurrent close/stop callbacks can settle while ownership cleanup is awaited.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poll !== undefined) clearTimeout(poll);
      input.signal.removeEventListener("abort", abort);
      if (failure instanceof RalphProcessOwnershipError) reject(failure);
      else if (stopReason !== undefined)
        resolve({
          status: exitStatus,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
          stopped: { reason: stopReason, knownProcessesStopped: true },
          ...(ownershipProbeRetries === undefined ? {} : { ownershipProbeRetries }),
        });
      else if (failure !== undefined) reject(failure);
      else
        resolve({
          status: exitStatus,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
          ...(ownershipProbeRetries === undefined ? {} : { ownershipProbeRetries }),
        });
    };
    const stopOwned = (): Promise<void> => {
      if (stopping !== undefined) return stopping;
      if (poll !== undefined) clearTimeout(poll);
      const startedAt = Date.now();
      const censusDeadline = startedAt + 250;
      stopDeadline = startedAt + 3250;
      const rootStop = { requested: false, termRequested: false, force: false };
      let censusTimer: ReturnType<typeof setTimeout> | undefined;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const requestRootStop = (): void => {
        if (rootStop.requested) return;
        rootStop.requested = true;
        clearTimeout(censusTimer);
        rootStop.termRequested = signalRoot("SIGTERM");
        // Allow the compatible CLI's one-second worker escalation from actual TERM.
        forceTimer = setTimeout(() => {
          rootStop.force = true;
          signalRoot("SIGKILL");
        }, 1250);
      };
      const stopWithoutCensus = (): void => {
        if (rootStop.requested) return;
        if (!(failure instanceof RalphProcessOwnershipError))
          failure = new RalphProcessOwnershipError(
            "RalphWorks pre-stop ancestry snapshot unavailable; retain execution ownership",
          );
        requestRootStop();
      };
      const captureBeforeTerm =
        !exited && !closed && !(failure instanceof RalphProcessOwnershipError);
      const pendingScan = scan;
      if (captureBeforeTerm) censusTimer = setTimeout(stopWithoutCensus, 250);
      else requestRootStop();
      let deadlineTimer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => {
          stopEnded = true;
          signalRoot("SIGKILL");
          reject(
            new RalphProcessOwnershipError(
              "RalphWorks process termination could not be verified; retain execution ownership",
            ),
          );
        }, 3250);
      });
      const cleanup = (async () => {
        try {
          if (captureBeforeTerm) {
            // A scan begun before cancellation may precede a newly spawned child.
            if (pendingScan !== undefined) await pendingScan;
            if (stopEnded) return;
            const current = await snapshot();
            // The independent deadline may settle while this census is awaited.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (stopEnded) return;
            if (!rootStop.requested) {
              // A late census cannot outrun an overdue fallback timer callback.
              if (
                Date.now() >= censusDeadline ||
                (!exited && !closed && !current.some((entry) => entry.pid === child.pid))
              )
                stopWithoutCensus();
              else {
                signalProcesses(current, "SIGTERM");
                requestRootStop();
              }
            }
          } else {
            await snapshot();
          }
          while (!stopEnded) {
            const remaining = await snapshot();
            // The deadline timer can finish stopping while the probe is awaited.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (stopEnded) return;
            if (remaining.length === 0 && closed) return;
            signalProcesses(remaining, rootStop.force ? "SIGKILL" : "SIGTERM");
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        } catch (error) {
          // Keep the first typed error even when pipe closure outlasts the deadline.
          if (
            !(failure instanceof RalphProcessOwnershipError) &&
            error instanceof RalphProcessOwnershipError
          )
            failure = error;
          requestRootStop();
          await childClosed;
          throw error;
        }
      })();
      stopping = Promise.race([cleanup, deadline])
        .catch((error: unknown) => {
          log.warn("RalphWorks stop ownership remains unverified", {
            data: {
              rootTermRequested: rootStop.termRequested,
              rootExited: exited,
              rootClosed: closed,
              stopElapsedMs: Math.max(0, Date.now() - startedAt),
              ...(error instanceof RalphProcessOwnershipError ? error.diagnostic : {}),
            },
          });
          throw error;
        })
        .finally(() => {
          stopEnded = true;
          clearTimeout(censusTimer);
          clearTimeout(forceTimer);
          clearTimeout(deadlineTimer);
        });
      return stopping;
    };
    const stop = (reason: string): void => {
      if (settled) return;
      if (reason === "RalphWorks execution cancelled") stopReason = "cancelled";
      if (reason === "RalphWorks execution timed out") stopReason ??= "timed_out";
      failure ??= new Error(reason);
      void stopOwned()
        .then(finish)
        .catch((error: unknown) => {
          failure =
            failure instanceof RalphProcessOwnershipError
              ? failure
              : error instanceof RalphProcessOwnershipError
                ? error
                : new RalphProcessOwnershipError(
                    error instanceof Error
                      ? error.message
                      : "RalphWorks process ownership could not be verified",
                  );
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            if (poll !== undefined) clearTimeout(poll);
            input.signal.removeEventListener("abort", abort);
            reject(failure);
          }
        });
    };
    const abort = (): void => stop("RalphWorks execution cancelled");
    input.signal.addEventListener("abort", abort, { once: true });
    const executionDeadline = Date.now() + input.timeoutMs;
    const timer = setTimeout(() => stop("RalphWorks execution timed out"), input.timeoutMs);
    const track = (): void => {
      if (settled || closed || stopping !== undefined) return;
      void snapshot()
        .then(() => {
          if (settled) return;
          if (Date.now() >= executionDeadline && stopReason === undefined)
            stop("RalphWorks execution timed out");
          if (!closed && stopping === undefined) poll = setTimeout(track, 100);
        })
        .catch((error: unknown) => {
          if (settled) return;
          failure =
            failure instanceof RalphProcessOwnershipError
              ? failure
              : error instanceof RalphProcessOwnershipError
                ? error
                : new RalphProcessOwnershipError("RalphWorks process ownership snapshot failed");
          stop(failure.message);
        });
    };
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) stop("RalphWorks command output limit exceeded");
      else chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", () => {
      failure ??= new Error("RalphWorks command could not start");
    });
    child.on("exit", () => {
      exited = true;
    });
    child.on("close", (status) => {
      closed = true;
      resolveClosed();
      exitStatus = status ?? 1;
      if (child.pid !== undefined) owned.delete(child.pid);
      void finish().catch((error: unknown) => {
        if (settled) return;
        failure =
          failure instanceof RalphProcessOwnershipError
            ? failure
            : error instanceof Error
              ? error
              : new Error("RalphWorks process ownership could not be verified");
        stop(failure.message);
      });
    });
    track();
    if (input.signal.aborted) abort();
  });
}
