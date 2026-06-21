/**
 * Protocol-agnostic runner surface that both ClaudeRunner and CodexRunner
 * implement. The AgentRunnerDispatcher routes each call to the right backend
 * based on the session's persisted AgentKind.
 */
export interface AgentRunner {
  checkIfRunning(sessionName?: string): Promise<boolean>;
  start(sessionName?: string, command?: string): Promise<void>;
  startWithResume(
    sessionName: string | undefined,
    sessionId: string,
    command?: string,
  ): Promise<void>;
  waitUntilReady(sessionName?: string): Promise<void>;
  waitUntilDone(sessionName?: string): Promise<{ done: boolean; output: string }>;
  interrupt(sessionName?: string): Promise<void>;
  /** Stop the running agent: Ctrl-C to interrupt any in-flight turn, then `/exit`.
   * Identical for claude and codex (both have `/exit`). */
  exit(sessionName?: string): Promise<void>;
  gracefulRestart(sessionName?: string): Promise<void>;
  gracefulRestartWithContinue(sessionName?: string, command?: string): Promise<void>;
}
