import type { OutputProcessor } from "../../session/output.js";
import type { TmuxBridge } from "../../session/tmux.js";
import type { ConfigResolver } from "../agent-config-resolver.js";
import { AgentRunnerBase } from "../runner-base.js";

/** Claude's POSITIVE ready marker: the TUI has booted and its composer is
 * accepting input — the bypass-permissions banner, OR the composer prompt cursor
 * "❯". Mirrors codex's positive "›" check. Absence-of-spinner alone is too weak:
 * a near-empty pane in the first second after launch (just the echoed command,
 * no banner yet) has no spinner and would false-positive as ready BEFORE the
 * trust gate even renders — live-verified. The trust gate (whose menu also shows
 * "❯") is handled by the base BEFORE this is consulted, so it never reaches here.
 * Exported (symmetric with codex's {@link paneLooksReady}) so it is testable. */
export function paneLooksReady(pane: string): boolean {
  return pane.includes("bypass permissions") || pane.includes("❯");
}

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

/** Claude backend — only the per-agent hooks differ from {@link AgentRunnerBase}. */
export class ClaudeRunner extends AgentRunnerBase {
  constructor(o: ClaudeRunnerOptions) {
    super({ ...o, command: o.claudeCommand });
  }

  protected readonly logTag = "[claude]";
  protected readonly notReadyError = "Claude did not become ready in time";

  protected isRunning(session: string): Promise<boolean> {
    return this.configResolver.isClaudeRunning(session);
  }

  protected readyMarker(pane: string): boolean {
    return paneLooksReady(pane);
  }

  protected resumeCommand(command: string, sessionId: string): string {
    return `${command} --resume ${sessionId}`;
  }

  protected continueCommand(command: string): string {
    return `${command} --continue`;
  }
}
