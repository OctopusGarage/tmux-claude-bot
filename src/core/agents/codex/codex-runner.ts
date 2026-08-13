import type { OutputProcessor } from "../../session/output.js";
import type { TmuxBridge } from "../../session/tmux.js";
import type { ConfigResolver } from "../agent-config-resolver.js";
import { AgentRunnerBase, paneHasActiveTurn } from "../runner-base.js";

export function paneLooksReady(pane: string): boolean {
  // Positive marker (codex's interactive composer `›` has rendered) AND no
  // work-in-progress spinner. A booting / not-yet-rendered pane lacks the
  // composer, so it is NOT ready — mirrors ClaudeRunner's positive-then-spinner
  // gate and avoids declaring ready before codex can accept input (which would
  // drop the first message typed in). The trust gate is handled earlier in the
  // wait loop, so its `›` selector never reaches here as a false "ready".
  return pane.includes("›") && !paneHasActiveTurn(pane);
}

export type CodexRunnerOptions = {
  bridge: TmuxBridge;
  output: OutputProcessor;
  configResolver: ConfigResolver;
  codexCommand: string;
  idlePollTicks: number;
  pollIntervalMs: number;
  maxWaitReadyMs: number;
  maxWaitDoneMs: number;
};

/** Codex backend — only the per-agent hooks differ from {@link AgentRunnerBase}. */
export class CodexRunner extends AgentRunnerBase {
  constructor(o: CodexRunnerOptions) {
    super({ ...o, command: o.codexCommand });
  }

  protected readonly logTag = "[codex]";
  protected readonly notReadyError = "Codex did not become ready in time";

  protected isRunning(session: string): Promise<boolean> {
    return this.configResolver.isCodexRunning(session);
  }

  protected readyMarker(pane: string): boolean {
    return paneLooksReady(pane);
  }

  protected resumeCommand(command: string, sessionId: string): string {
    return `${command} resume ${sessionId}`;
  }

  protected continueCommand(command: string): string {
    return `${command} resume --last`;
  }
}
