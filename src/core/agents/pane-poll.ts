import { createLogger } from "../../shared/utils/logger.js";
import { sleep } from "../../shared/utils/sleep.js";
import type { OutputProcessor } from "../session/output.js";
import type { TmuxBridge } from "../session/tmux.js";

const log = createLogger("agents.pane-poll");

/** What a per-agent readiness classifier wants the poll loop to do for a pane:
 * `"ready"` (stop, done) | `"wait"` (keep polling) | `{ sendRawKey(s) }` (send
 * one or more keys — e.g. a confirm gate's selection + Enter — then keep polling). */
export type ReadyVerdict =
  | "ready"
  | "wait"
  | { sendRawKey: string }
  | { sendRawKeys: readonly string[] };

type PaneAction = Extract<ReadyVerdict, object>;

/**
 * Prose-agnostic readiness fallback for `pollUntilReady`. When the positive
 * marker never matches (e.g. a future UI re-skin breaks it), a pane that has been
 * byte-identical for `ticks` consecutive polls — with the agent process alive and
 * the pane carrying real content (`minLines` non-blank lines, so a bare boot pane
 * never qualifies) — is treated as ready. This can't hang and, unlike the marker,
 * survives a UI restyle; the only thing it can't do is auto-accept a confirm gate
 * the classifier failed to recognize (the user can still accept it by hand).
 */
export interface StableReady {
  ticks: number;
  minLines: number;
  isAlive(): Promise<boolean>;
}

function nonBlankLineCount(pane: string): number {
  return pane.split("\n").filter((l) => l.trim().length > 0).length;
}

/**
 * Poll the pane until a per-agent `classify` predicate reports it ready (or the
 * optional {@link StableReady} fallback fires), or `maxWaitReadyMs` elapses
 * (throws `notReadyError`). Shared scaffold for the claude and codex runners'
 * waitUntilReady; the readiness logic — and any keystroke a not-yet-ready pane
 * needs (the trust gate) — lives in the injected classifier.
 */
export async function pollUntilReady(opts: {
  bridge: TmuxBridge;
  pollIntervalMs: number;
  maxWaitReadyMs: number;
  sessionName?: string | undefined;
  logTag: string;
  notReadyError: string;
  classify(pane: string): ReadyVerdict;
  isActiveTurn?: (pane: string) => boolean;
  stableReady?: StableReady;
}): Promise<void> {
  const { bridge, pollIntervalMs, maxWaitReadyMs, sessionName, logTag, notReadyError, classify } =
    opts;
  const maxIterations = Math.ceil(maxWaitReadyMs / pollIntervalMs);
  const sess = sessionName ?? "default";
  log.debug("agent readiness wait started", {
    session: sess,
    data: { agent: logTag, maxIterations, pollIntervalMs },
  });
  let lastPane: string | null = null;
  let stable = 0;
  let captureFailures = 0;
  let lastCaptureError: unknown;
  for (let i = 0; i < maxIterations; i++) {
    let pane: string;
    try {
      pane = await bridge.capturePane(sessionName);
    } catch (err) {
      captureFailures += 1;
      lastCaptureError = err;
      const context = {
        session: sess,
        err,
        data: { agent: logTag, iteration: i, failures: captureFailures },
      };
      if (captureFailures === 1)
        log.warn("agent pane capture failed during readiness wait", context);
      else log.debug("agent pane capture still failing during readiness wait", context);
      await sleep(pollIntervalMs);
      continue;
    }
    if (captureFailures > 0) {
      log.info("agent pane capture recovered", {
        session: sess,
        data: { agent: logTag, failures: captureFailures, iteration: i },
      });
      captureFailures = 0;
      lastCaptureError = undefined;
    }
    const verdict = classify(pane);
    if (verdict === "ready") {
      log.info("agent ready", {
        session: sess,
        data: { agent: logTag, evidence: "marker", iteration: i },
      });
      return;
    }
    if (typeof verdict === "object") {
      const keys = "sendRawKeys" in verdict ? verdict.sendRawKeys : [verdict.sendRawKey];
      log.info("agent readiness gate action", {
        session: sess,
        data: { agent: logTag, keys, iteration: i },
      });
      for (const key of keys) await bridge.sendRawKey(key, sessionName);
      stable = 0; // a gate that auto-clears must never count toward "stable = ready"
      lastPane = pane;
      await sleep(pollIntervalMs);
      continue;
    }
    // verdict === "wait": fall back to stability when the marker can't decide.
    const sr = opts.stableReady;
    if (opts.isActiveTurn?.(pane)) {
      stable = 0;
      lastPane = pane;
      await sleep(pollIntervalMs);
      continue;
    }
    if (sr && lastPane !== null && pane === lastPane) {
      stable++;
      if (stable >= sr.ticks && nonBlankLineCount(pane) >= sr.minLines && (await sr.isAlive())) {
        log.info("agent ready", {
          session: sess,
          data: { agent: logTag, evidence: "stable-pane", stable, iteration: i },
        });
        return;
      }
    } else {
      stable = 0;
    }
    lastPane = pane;
    await sleep(pollIntervalMs);
  }
  log.error("agent readiness wait timed out", {
    session: sess,
    ...(lastCaptureError === undefined ? {} : { err: lastCaptureError }),
    data: { agent: logTag, maxIterations, captureFailures },
  });
  throw new Error(notReadyError);
}

/**
 * Poll the pane until it is stable for `idlePollTicks` consecutive polls (done)
 * or `maxWaitDoneMs` elapses (one waiting round exhausted — the task may well
 * still be running; callers decide whether to keep waiting). Shared verbatim by
 * the claude and codex runners; `logTag` selects the per-agent log prefix.
 */
export async function pollUntilIdle(opts: {
  bridge: TmuxBridge;
  output: OutputProcessor;
  idlePollTicks: number;
  pollIntervalMs: number;
  maxWaitDoneMs: number;
  sessionName?: string | undefined;
  logTag: string;
  isActiveTurn?: (pane: string) => boolean;
  activePaneAction?: (pane: string) => "wait" | PaneAction;
}): Promise<{ done: boolean; output: string }> {
  const {
    bridge,
    output,
    idlePollTicks,
    pollIntervalMs,
    maxWaitDoneMs,
    sessionName,
    logTag,
    isActiveTurn,
    activePaneAction,
  } = opts;
  let identicalCount = 0;
  let lastContent = "";
  const maxIterations = Math.ceil(maxWaitDoneMs / pollIntervalMs);
  const sess = sessionName ?? "default";
  log.debug("agent completion wait started", {
    session: sess,
    data: { agent: logTag, maxIterations, pollIntervalMs },
  });
  let captureFailures = 0;
  let totalCaptureFailures = 0;
  let lastCaptureError: unknown;

  for (let i = 0; i < maxIterations; i++) {
    let pane: string;
    try {
      pane = await bridge.capturePane(sessionName);
    } catch (err) {
      captureFailures += 1;
      totalCaptureFailures += 1;
      lastCaptureError = err;
      const context = {
        session: sess,
        err,
        data: { agent: logTag, iteration: i, failures: captureFailures },
      };
      if (captureFailures === 1)
        log.warn("agent pane capture failed during completion wait", context);
      else log.debug("agent pane capture still failing during completion wait", context);
      await sleep(pollIntervalMs);
      continue;
    }
    if (captureFailures > 0) {
      log.info("agent pane capture recovered", {
        session: sess,
        data: { agent: logTag, failures: captureFailures, iteration: i },
      });
      captureFailures = 0;
      lastCaptureError = undefined;
    }

    const action = activePaneAction?.(pane);
    if (action && action !== "wait") {
      const keys = "sendRawKeys" in action ? action.sendRawKeys : [action.sendRawKey];
      log.info("agent completion gate action", {
        session: sess,
        data: { agent: logTag, keys, iteration: i },
      });
      for (const key of keys) await bridge.sendRawKey(key, sessionName);
      identicalCount = 0;
      lastContent = pane;
      await sleep(pollIntervalMs);
      continue;
    }

    if (isActiveTurn?.(pane)) {
      if (i % 30 === 0 || identicalCount > 0) {
        log.debug("agent turn remains active", {
          session: sess,
          data: { agent: logTag, iteration: i },
        });
      }
      identicalCount = 0;
      lastContent = pane;
      await sleep(pollIntervalMs);
      continue;
    }

    // Idle detection: content stable for idlePollTicks consecutive polls
    if (pane === lastContent) {
      identicalCount++;
      if (i % 30 === 0 || identicalCount >= idlePollTicks) {
        const lines = pane.split("\n").filter((l) => l.trim().length > 0);
        const lastLine = lines[lines.length - 1] ?? "";
        log.debug("agent pane remains stable", {
          session: sess,
          data: {
            agent: logTag,
            iteration: i,
            identicalCount,
            lastLine: lastLine.trim().slice(0, 80),
          },
        });
      }
      if (identicalCount >= idlePollTicks) {
        const processed = output.process(pane);
        log.info("agent completion detected", {
          session: sess,
          data: { agent: logTag, iteration: i, outputLength: processed.length },
        });
        return { done: true, output: processed };
      }
    } else {
      if (identicalCount > 0) {
        log.debug("agent pane changed", {
          session: sess,
          data: { agent: logTag, iteration: i, previousIdenticalCount: identicalCount },
        });
      }
      identicalCount = 0;
    }

    lastContent = pane;
    await sleep(pollIntervalMs);
  }

  // Round exhausted — hand back what we have; the caller owns the messaging.
  const processed = output.process(lastContent);
  log.warn("agent completion wait timed out", {
    session: sess,
    ...(lastCaptureError === undefined ? {} : { err: lastCaptureError }),
    data: {
      agent: logTag,
      maxIterations,
      outputLength: processed.length,
      totalCaptureFailures,
    },
  });
  return { done: false, output: processed };
}
