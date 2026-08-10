import { logger } from "../../shared/utils/logger.js";
import { sleep } from "../../shared/utils/sleep.js";
import type { OutputProcessor } from "../session/output.js";
import type { TmuxBridge } from "../session/tmux.js";
import type { ConfigResolver } from "./agent-config-resolver.js";
import { pollUntilIdle, pollUntilReady, type ReadyVerdict } from "./pane-poll.js";
import type { AgentRunner } from "./runner.js";

/** Grace period after `/exit` before relaunching on a restart. */
const EXIT_GRACE_MS = 2000;

/** A blocking confirm gate is currently active near the bottom of the pane.
 * Shared by both agents. Covers the known first-launch gates by their
 * live-verified wording PLUS a structural cue so a future re-word still clears:
 *   - codex directory-trust:  "Do you trust the contents of this directory?"
 *   - claude directory-trust: "...one you trust?" / menu "1. Yes, I trust this folder"
 *   - claude bypass-permissions accept (first --dangerously-skip-permissions run):
 *     "Yes, I accept"
 *   - generic: the "Enter to confirm" hint these menus print near the bottom.
 * Best-effort: a gate this misses is still caught by the stability fallback in
 * pollUntilReady (it won't hang), it just won't be auto-accepted. */
export function paneNeedsConfirm(pane: string): boolean {
  return paneConfirmAction(pane) !== "wait";
}

/** Whether the pane's latest lifecycle evidence still represents an active turn.
 * Codex can leave an old `esc to interrupt` line visible after a goal finishes;
 * its footer then carries a later `Context … Goal achieved` marker. Compare the
 * evidence order so stale scrollback cannot block the next queued prompt, while a
 * newer working marker still wins if another turn has started. */
export function paneHasActiveTurn(pane: string): boolean {
  const activeAt = pane.toLowerCase().lastIndexOf("esc to interrupt");
  if (activeAt < 0) return false;

  let completedAt = -1;
  for (const match of pane.matchAll(/^.*\bcontext\b.*\bgoal achieved\b.*$/gimu)) {
    completedAt = match.index;
  }
  return activeAt > completedAt;
}

export function paneConfirmAction(pane: string): ReadyVerdict {
  if (activeCodexAdditionalSafetyMenu(pane)) return "wait";
  if (!activeConfirmGate(pane)) return "wait";
  if (pane.includes("Bypass Permissions mode") && pane.includes("Yes, I accept")) {
    if (/❯\s*2\.\s*Yes, I accept/.test(pane)) return { sendRawKey: "Enter" };
    return { sendRawKeys: ["Down", "Enter"] };
  }
  return { sendRawKey: "Enter" };
}

export function paneCodexAdditionalSafetyAction(pane: string): ReadyVerdict {
  if (!activeCodexAdditionalSafetyMenu(pane)) return "wait";
  if (/❯\s*2\.\s*Keep waiting/i.test(pane)) return { sendRawKey: "Enter" };
  return { sendRawKeys: ["Down", "Enter"] };
}

function activeConfirmGate(pane: string): boolean {
  const lines = pane.split("\n");
  const lastNonBlank = findLastNonBlankLine(lines);
  if (lastNonBlank < 0) return false;

  const hintLine = findLastLine(lines, (line) =>
    /(?:Enter|Press enter) to (?:confirm|continue)/i.test(line),
  );
  if (hintLine >= 0) return hintLine === lastNonBlank;

  const gateLine = findLastLine(
    lines,
    (line) =>
      line.includes("Do you trust") ||
      line.includes("I trust this folder") ||
      line.includes("Yes, I accept"),
  );
  return gateLine >= 0 && lastNonBlank - gateLine <= 3;
}

function activeCodexAdditionalSafetyMenu(pane: string): boolean {
  const lines = pane.split("\n");
  const lastNonBlank = findLastNonBlankLine(lines);
  if (lastNonBlank < 0) return false;
  const lastLine = lines[lastNonBlank] ?? "";
  return (
    /Additional safety checks/i.test(pane) &&
    /Retry with a faster model/i.test(pane) &&
    /Keep waiting/i.test(pane) &&
    /Press enter to confirm or esc to go back/i.test(lastLine)
  );
}

function findLastNonBlankLine(lines: readonly string[]): number {
  return findLastLine(lines, (line) => line.trim().length > 0);
}

function findLastLine(lines: readonly string[], pred: (line: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pred(lines[i] ?? "")) return i;
  }
  return -1;
}

export type AgentRunnerOptions = {
  bridge: TmuxBridge;
  output: OutputProcessor;
  configResolver: ConfigResolver;
  command: string;
  idlePollTicks: number;
  pollIntervalMs: number;
  maxWaitReadyMs: number;
  maxWaitDoneMs: number;
};

/**
 * Shared lifecycle for both agent runners. The whole flow — check-running, start,
 * resume, exit, restart, wait-ready, wait-done, interrupt — is identical between
 * claude and codex; ONLY a handful of per-agent specifics differ, expressed as
 * abstract hooks: which process to detect, how to read "ready" off the pane, the
 * resume/continue command syntax, and what to do right after a launch (codex
 * clears its trust-directory gate; claude no-ops). Keeping the flow here means the
 * two subclasses are just those hooks — no duplicated wiring to drift.
 */
export abstract class AgentRunnerBase implements AgentRunner {
  protected readonly bridge: TmuxBridge;
  protected readonly output: OutputProcessor;
  protected readonly configResolver: ConfigResolver;
  protected readonly command: string;
  protected readonly idlePollTicks: number;
  protected readonly pollIntervalMs: number;
  protected readonly maxWaitReadyMs: number;
  protected readonly maxWaitDoneMs: number;

  constructor(o: AgentRunnerOptions) {
    this.bridge = o.bridge;
    this.output = o.output;
    this.configResolver = o.configResolver;
    this.command = o.command;
    this.idlePollTicks = o.idlePollTicks;
    this.pollIntervalMs = o.pollIntervalMs;
    this.maxWaitReadyMs = o.maxWaitReadyMs;
    this.maxWaitDoneMs = o.maxWaitDoneMs;
  }

  /** Log prefix, e.g. `[claude]` / `[codex]`. */
  protected abstract readonly logTag: string;
  /** Error thrown when waitUntilReady times out. */
  protected abstract readonly notReadyError: string;
  /** Process-based "is this agent running in the session's pane". */
  protected abstract isRunning(session: string): Promise<boolean>;
  /** The agent's POSITIVE ready marker (its composer/prompt has rendered). The
   * trust gate is handled by the base BEFORE this is consulted, so a trust screen
   * never reaches here. Agent-specific (claude vs codex render differently). */
  protected abstract readyMarker(pane: string): boolean;
  /** Resume an EXACT session id: `claude --resume <id>` / `codex resume <id>`. */
  protected abstract resumeCommand(command: string, sessionId: string): string;
  /** Resume the most recent session: `claude --continue` / `codex resume --last`. */
  protected abstract continueCommand(command: string): string;

  /** A pane marker that means the agent is still working even when the visible
   * screen bytes are stable. Both Claude and Codex expose this TUI hint while a
   * turn is active; without this guard, the queue can type the next message into
   * Codex's composer before the previous turn is actually done. */
  protected activeTurnMarker(pane: string): boolean {
    return paneHasActiveTurn(pane);
  }

  /** After a launch: clear the trust-directory gate (BOTH agents show it on first
   * launch in a dir, blocking input) and wait for the composer. Best-effort —
   * swallow a slow/failed boot so the caller's action still completes (the user
   * can retry). Shared by both agents; never silently defaults to one's behavior. */
  protected async waitReadyBestEffort(sessionName?: string): Promise<void> {
    try {
      await this.waitUntilReady(sessionName);
      logger.info(`${this.logTag} agent ready`);
    } catch (err) {
      logger.warn(
        `${this.logTag} post-launch: trust-clear/readiness did not complete: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async checkIfRunning(sessionName?: string): Promise<boolean> {
    const session = await this.bridge.resolveSessionName(sessionName);
    const running = await this.isRunning(session);
    logger.info(`${this.logTag} checkIfRunning session=${session} → ${running} (process-based)`);
    return running;
  }

  async start(sessionName?: string, command?: string): Promise<void> {
    if (await this.checkIfRunning(sessionName)) return;
    logger.info(`${this.logTag} starting agent`, { data: { resume: "fresh" } });
    await this.bridge.sendKeys(command ?? this.command, sessionName);
    await this.waitReadyBestEffort(sessionName);
  }

  async startWithResume(
    sessionName: string | undefined,
    sessionId: string,
    command?: string,
  ): Promise<void> {
    if (await this.checkIfRunning(sessionName)) return;
    logger.info(`${this.logTag} starting agent`, {
      data: { resume: "exact-id", sessionId },
    });
    await this.bridge.sendKeys(this.resumeCommand(command ?? this.command, sessionId), sessionName);
    await this.waitReadyBestEffort(sessionName);
  }

  async waitUntilReady(sessionName?: string): Promise<void> {
    const resolved = await this.bridge.resolveSessionName(sessionName);
    return pollUntilReady({
      bridge: this.bridge,
      pollIntervalMs: this.pollIntervalMs,
      maxWaitReadyMs: this.maxWaitReadyMs,
      sessionName,
      logTag: this.logTag,
      notReadyError: this.notReadyError,
      // Confirm gate FIRST (shared, both agents) — select the affirmative action
      // when needed, then confirm; otherwise defer to the agent's positive ready
      // marker so a gate screen is never a false "ready".
      classify: (pane) => {
        const safety = paneCodexAdditionalSafetyAction(pane);
        if (safety !== "wait") return safety;
        const confirm = paneConfirmAction(pane);
        if (confirm !== "wait") return confirm;
        if (this.activeTurnMarker(pane)) return "wait";
        return this.readyMarker(pane) ? "ready" : "wait";
      },
      isActiveTurn: (pane) => this.activeTurnMarker(pane),
      // Prose-agnostic fallback: if the marker never matches (UI re-skin), a pane
      // stable for idlePollTicks polls — with the agent process alive and real
      // content on screen — is ready. Survives a restyle and can't hang.
      stableReady: {
        ticks: this.idlePollTicks,
        minLines: 3,
        isAlive: () => this.isRunning(resolved),
      },
    });
  }

  async waitUntilInputReady(sessionName?: string): Promise<void> {
    const resolved = await this.bridge.resolveSessionName(sessionName);
    const blocksInput = (pane: string) => this.activeTurnMarker(pane) || paneNeedsConfirm(pane);
    return pollUntilReady({
      bridge: this.bridge,
      pollIntervalMs: this.pollIntervalMs,
      maxWaitReadyMs: this.maxWaitReadyMs,
      sessionName,
      logTag: this.logTag,
      notReadyError: this.notReadyError,
      classify: (pane) => {
        const safety = paneCodexAdditionalSafetyAction(pane);
        if (safety !== "wait") return safety;
        if (blocksInput(pane)) return "wait";
        return this.readyMarker(pane) ? "ready" : "wait";
      },
      isActiveTurn: blocksInput,
      stableReady: {
        ticks: this.idlePollTicks,
        minLines: 3,
        isAlive: () => this.isRunning(resolved),
      },
    });
  }

  async waitUntilDone(sessionName?: string): Promise<{ done: boolean; output: string }> {
    return pollUntilIdle({
      bridge: this.bridge,
      output: this.output,
      idlePollTicks: this.idlePollTicks,
      pollIntervalMs: this.pollIntervalMs,
      maxWaitDoneMs: this.maxWaitDoneMs,
      sessionName,
      logTag: this.logTag,
      isActiveTurn: (pane) => this.activeTurnMarker(pane) || paneNeedsConfirm(pane),
      activePaneAction: (pane) => {
        const safety = paneCodexAdditionalSafetyAction(pane);
        return safety === "ready" ? "wait" : safety;
      },
    });
  }

  async interrupt(sessionName?: string): Promise<void> {
    await this.bridge.sendRawKey("Escape", sessionName);
  }

  async exit(sessionName?: string): Promise<void> {
    // Ctrl-C interrupts any in-flight turn, then `/exit` quits. Both agents.
    logger.info(`${this.logTag} exiting agent`);
    await this.bridge.sendExit(sessionName);
  }

  async gracefulRestart(sessionName?: string): Promise<void> {
    logger.info(`${this.logTag} restarting agent`, { data: { resume: "fresh" } });
    await this.bridge.sendExit(sessionName);
    await sleep(EXIT_GRACE_MS);
    await this.start(sessionName);
  }

  async gracefulRestartWithContinue(sessionName?: string, command?: string): Promise<void> {
    // Capture the EXACT running session id from the live process (its open
    // transcript) BEFORE exiting, so we resume THAT conversation — not merely "the
    // most recent in the dir". Falls back to the continue command when the id
    // can't be read (no live transcript open).
    const resolved = await this.bridge.resolveSessionName(sessionName);
    // Prefer the EXACT live id; if the pid isn't holding the transcript open right
    // now, fall back to the last-observed live id (disambiguates co-located Free
    // Projects, where continueCommand's "newest in dir" can resume the wrong one).
    const sessionId =
      (await this.configResolver.resolveLiveTranscript?.(resolved))?.sessionId ??
      this.configResolver.lastLiveSessionId?.(resolved) ??
      null;
    logger.info(`${this.logTag} restarting agent`, {
      data: { resume: sessionId ? "exact-id" : "continue", ...(sessionId ? { sessionId } : {}) },
    });
    await this.bridge.sendExit(sessionName);
    await sleep(EXIT_GRACE_MS);
    if (await this.checkIfRunning(sessionName)) return; // didn't exit — don't double-launch
    const cmd = command ?? this.command;
    await this.bridge.sendKeys(
      sessionId ? this.resumeCommand(cmd, sessionId) : this.continueCommand(cmd),
      sessionName,
    );
    await this.waitReadyBestEffort(sessionName);
  }
}
