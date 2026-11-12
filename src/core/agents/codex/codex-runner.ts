import type { OutputProcessor } from "../../session/output.js";
import type { TmuxBridge } from "../../session/tmux.js";
import type { ConfigResolver } from "../agent-config-resolver.js";
import { AgentRunnerBase, paneHasActiveTurn } from "../runner-base.js";

export function paneLooksReady(pane: string): boolean {
  if (paneHasActiveTurn(pane)) return false;
  const lines = pane
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const composer = lines.map((line) => line.startsWith("›")).lastIndexOf(true);
  if (composer < 0 || /^›\s*\d+\./.test(lines[composer] ?? "")) return false;
  // Only a current composer followed by its known status/hint lines is positive
  // evidence. Menu selectors and historical prompts above boot text are not.
  // Pending text and colored placeholders still use the separate input guard.
  return lines
    .slice(composer + 1)
    .every((line) =>
      /^(?:esc again to edit previous message|\? for shortcuts|(?:.*[·•]\s*)?(?:Context \d+% left|\d+% context left)\b.*|gpt-[\w.-]+\s*[·•].*)$/i.test(
        line,
      ),
    );
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

  isFreshStartCommand(command?: string): boolean {
    // Conservative direct interactive launches only; unknown shell launchers never grant bootstrap.
    return /^(?:[A-Za-z0-9_.~/-]+\/)?codex(?:\s+(?:--dangerously-bypass-approvals-and-sandbox|--full-auto|--no-alt-screen|--yolo))*$/.test(
      (command ?? this.command).trim(),
    );
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
