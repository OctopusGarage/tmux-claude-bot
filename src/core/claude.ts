import { logger } from "../shared/utils/logger.js";
import type { ConfigResolver } from "./claude-config-resolver.js";
import type { OutputProcessor } from "./output.js";
import type { TmuxBridge } from "./tmux.js";

export type ClaudeRunnerOptions = {
  bridge: TmuxBridge;
  output: OutputProcessor;
  configResolver: ConfigResolver;
  claudeCommand: string;
  idlePollTicks: number;
  pollIntervalMs: number;
  maxWaitReadyMs: number;
  maxWaitDoneMs: number;
};

export class ClaudeRunner {
  private readonly bridge: TmuxBridge;
  private readonly output: OutputProcessor;
  private readonly configResolver: ConfigResolver;
  private readonly claudeCommand: string;
  private readonly idlePollTicks: number;
  private readonly pollIntervalMs: number;
  private readonly maxWaitReadyMs: number;
  private readonly maxWaitDoneMs: number;
  private running = false;

  constructor(options: ClaudeRunnerOptions) {
    this.bridge = options.bridge;
    this.output = options.output;
    this.configResolver = options.configResolver;
    this.claudeCommand = options.claudeCommand;
    this.idlePollTicks = options.idlePollTicks;
    this.pollIntervalMs = options.pollIntervalMs;
    this.maxWaitReadyMs = options.maxWaitReadyMs;
    this.maxWaitDoneMs = options.maxWaitDoneMs;
  }

  isRunning(): boolean {
    return this.running;
  }

  // Whether Claude is running in the pane, decided by process detection (is a
  // claude process present in the pane's process tree) rather than scraping the
  // screen for a spinner / shell prompt — which was theme-dependent and gave
  // false positives. Reuses the same primitive as the config-dir resolver.
  async checkIfRunning(sessionName?: string): Promise<boolean> {
    const session = await this.bridge.resolveSessionName(sessionName);
    const running = await this.configResolver.isClaudeRunning(session);
    logger.info(`[claude] checkIfRunning session=${session} → ${running} (process-based)`);
    return running;
  }

  async start(sessionName?: string): Promise<void> {
    const alreadyRunning = await this.checkIfRunning(sessionName);
    if (alreadyRunning) {
      this.running = true;
      return;
    }
    await this.bridge.sendKeys(this.claudeCommand, sessionName);
    // Don't wait - user will confirm when ready
    this.running = true;
  }

  async startWithResume(sessionName: string | undefined, sessionId: string): Promise<void> {
    const alreadyRunning = await this.checkIfRunning(sessionName);
    if (alreadyRunning) return;
    await this.bridge.sendKeys(`${this.claudeCommand} --resume ${sessionId}`, sessionName);
    this.running = true;
  }

  async waitUntilReady(sessionName?: string): Promise<void> {
    const maxIterations = Math.ceil(this.maxWaitReadyMs / this.pollIntervalMs);
    const sess = sessionName ?? "default";
    logger.info(`[claude] waitUntilReady start session=${sess} maxIterations=${maxIterations}`);
    for (let i = 0; i < maxIterations; i++) {
      let pane: string;
      try {
        pane = await this.bridge.capturePane(sessionName);
      } catch (err) {
        logger.error(
          `[claude] waitUntilReady capturePane failed iter=${i}: ${err instanceof Error ? err.message : err}`,
        );
        await this.sleep(this.pollIntervalMs);
        continue;
      }
      // Primary: bypass permissions UI is visible
      if (pane.includes("bypass permissions")) {
        logger.info(
          `[claude] waitUntilReady session=${sess} ready at iter=${i} (bypass permissions detected)`,
        );
        return;
      }
      // Fallback: no spinner in last two lines suggests ready
      const lines = pane.split("\n").filter((l) => l.trim().length > 0);
      const lastLine = lines[lines.length - 1] ?? "";
      const secondLastLine = lines[lines.length - 2] ?? "";
      if (!lastLine.trim().startsWith("⏵⏵") && !secondLastLine.trim().startsWith("⏵⏵")) {
        logger.info(`[claude] waitUntilReady session=${sess} ready at iter=${i} (no spinner)`);
        return;
      }
      await this.sleep(this.pollIntervalMs);
    }
    logger.error(
      `[claude] waitUntilReady session=${sess} TIMEOUT after ${maxIterations} iterations`,
    );
    throw new Error("Claude did not become ready in time");
  }

  /**
   * Poll the pane until it is stable for `idlePollTicks` consecutive polls
   * (done) or `maxWaitDoneMs` elapses (one waiting round exhausted — the task
   * may well still be running; callers decide whether to keep waiting).
   */
  async waitUntilDone(sessionName?: string): Promise<{ done: boolean; output: string }> {
    let identicalCount = 0;
    let lastContent = "";
    const maxIterations = Math.ceil(this.maxWaitDoneMs / this.pollIntervalMs);
    const sess = sessionName ?? "default";
    logger.info(
      `[claude] waitUntilDone start session=${sess} maxIterations=${maxIterations} pollMs=${this.pollIntervalMs}`,
    );

    for (let i = 0; i < maxIterations; i++) {
      let pane: string;
      try {
        pane = await this.bridge.capturePane(sessionName);
      } catch (err) {
        logger.error(
          `[claude] waitUntilDone capturePane failed iter=${i}: ${err instanceof Error ? err.message : err}`,
        );
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      // Idle detection: content stable for idlePollTicks consecutive polls
      if (pane === lastContent) {
        identicalCount++;
        if (i % 30 === 0 || identicalCount >= this.idlePollTicks) {
          const lines = pane.split("\n").filter((l) => l.trim().length > 0);
          const lastLine = lines[lines.length - 1] ?? "";
          logger.info(
            `[claude] waitUntilDone session=${sess} iter=${i} identical=${identicalCount} last="${lastLine.trim().slice(0, 80)}"`,
          );
        }
        if (identicalCount >= this.idlePollTicks) {
          const processed = this.output.process(pane);
          logger.info(
            `[claude] waitUntilDone session=${sess} idle detected after ${i} iterations, output_len=${processed.length}`,
          );
          return { done: true, output: processed };
        }
      } else {
        if (identicalCount > 0) {
          logger.info(
            `[claude] waitUntilDone session=${sess} iter=${i} content changed, reset idleCount`,
          );
        }
        identicalCount = 0;
      }

      lastContent = pane;
      await this.sleep(this.pollIntervalMs);
    }

    // Round exhausted — hand back what we have; the caller owns the messaging.
    const processed = this.output.process(lastContent);
    logger.warn(
      `[claude] waitUntilDone session=${sess} TIMEOUT after ${maxIterations} iterations, output_len=${processed.length}`,
    );
    return { done: false, output: processed };
  }

  async interrupt(sessionName?: string): Promise<void> {
    await this.bridge.sendRawKey("Escape", sessionName);
  }

  async gracefulRestart(sessionName?: string): Promise<void> {
    this.running = false;
    await this.bridge.sendExit(sessionName);
    await this.sleep(2000);
    await this.start(sessionName);
  }

  async gracefulRestartWithContinue(sessionName?: string): Promise<void> {
    this.running = false;
    await this.bridge.sendExit(sessionName);
    await this.sleep(2000);
    if (await this.checkIfRunning(sessionName)) {
      this.running = true;
      return;
    }
    await this.bridge.sendKeys(`${this.claudeCommand} --continue`, sessionName);
    await this.waitUntilReady(sessionName);
    this.running = true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
