import { logger } from "../../shared/utils/logger.js";
import { sleep } from "../../shared/utils/sleep.js";
import type { OutputProcessor } from "../session/output.js";
import type { TmuxBridge } from "../session/tmux.js";
import type { ConfigResolver } from "./agent-config-resolver.js";
import { pollUntilIdle, pollUntilReady } from "./pane-poll.js";
import type { AgentRunner } from "./runner.js";

/** Grace period after `/exit` before relaunching on a restart. */
const EXIT_GRACE_MS = 2000;

/** A blocking confirm gate that Enter accepts is on screen — type the default-Yes
 * Enter to clear it. Shared by both agents. Covers the known first-launch gates by
 * their live-verified wording PLUS a structural cue so a future re-word still
 * clears:
 *   - codex directory-trust:  "Do you trust the contents of this directory?"
 *   - claude directory-trust: "...one you trust?" / menu "1. Yes, I trust this folder"
 *   - claude bypass-permissions accept (first --dangerously-skip-permissions run):
 *     "Yes, I accept"
 *   - generic: the "Enter to confirm" hint these menus print at the bottom — a
 *     structural signal that survives prose changes (the ready composer has no
 *     such hint).
 * Best-effort: a gate this misses is still caught by the stability fallback in
 * pollUntilReady (it won't hang), it just won't be auto-accepted. */
export function paneNeedsConfirm(pane: string): boolean {
  return (
    pane.includes("Do you trust") ||
    pane.includes("I trust this folder") ||
    pane.includes("Yes, I accept") ||
    pane.includes("Enter to confirm")
  );
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

  /** After a launch: clear the trust-directory gate (BOTH agents show it on first
   * launch in a dir, blocking input) and wait for the composer. Best-effort —
   * swallow a slow/failed boot so the caller's action still completes (the user
   * can retry). Shared by both agents; never silently defaults to one's behavior. */
  protected async waitReadyBestEffort(sessionName?: string): Promise<void> {
    try {
      await this.waitUntilReady(sessionName);
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
    await this.bridge.sendKeys(command ?? this.command, sessionName);
    await this.waitReadyBestEffort(sessionName);
  }

  async startWithResume(sessionName: string | undefined, sessionId: string): Promise<void> {
    if (await this.checkIfRunning(sessionName)) return;
    await this.bridge.sendKeys(this.resumeCommand(this.command, sessionId), sessionName);
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
      // Confirm gate FIRST (shared, both agents) — answer Yes with Enter; otherwise
      // defer to the agent's positive ready marker so a gate screen is never a
      // false "ready".
      classify: (pane) => {
        if (paneNeedsConfirm(pane)) return { sendRawKey: "Enter" };
        return this.readyMarker(pane) ? "ready" : "wait";
      },
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

  async waitUntilDone(sessionName?: string): Promise<{ done: boolean; output: string }> {
    return pollUntilIdle({
      bridge: this.bridge,
      output: this.output,
      idlePollTicks: this.idlePollTicks,
      pollIntervalMs: this.pollIntervalMs,
      maxWaitDoneMs: this.maxWaitDoneMs,
      sessionName,
      logTag: this.logTag,
    });
  }

  async interrupt(sessionName?: string): Promise<void> {
    await this.bridge.sendRawKey("Escape", sessionName);
  }

  async exit(sessionName?: string): Promise<void> {
    // Ctrl-C interrupts any in-flight turn, then `/exit` quits. Both agents.
    await this.bridge.sendExit(sessionName);
  }

  async gracefulRestart(sessionName?: string): Promise<void> {
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
    const sessionId =
      (await this.configResolver.resolveLiveTranscript?.(resolved))?.sessionId ?? null;
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
