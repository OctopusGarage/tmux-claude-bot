import type { TmuxBridge } from "../session/tmux.js";
import type { ConfigResolver } from "./agent-config-resolver.js";
import { resolveAgentKind } from "./agentKindMap.js";
import { recordLiveSessionId } from "./live-session-id.js";
import type { AgentRunner } from "./runner.js";
import { markSessionRunning, markSessionStopped } from "./runningSessions.js";

/**
 * Routes every AgentRunner call to the claude or codex backend based on which
 * agent is LIVE in the resolved session (process-detected via the config
 * resolver), falling back to the persisted launch-intent for the brief gap
 * before a freshly-started process is visible. Exposed to handlers as
 * deps.agent; every call site uses it unchanged regardless of agent.
 */
export class AgentRunnerDispatcher implements AgentRunner {
  private readonly bridge: TmuxBridge;
  private readonly claude: AgentRunner;
  private readonly codex: AgentRunner;
  private readonly configResolver: ConfigResolver;

  constructor(options: {
    bridge: TmuxBridge;
    claude: AgentRunner;
    codex: AgentRunner;
    configResolver: ConfigResolver;
  }) {
    this.bridge = options.bridge;
    this.claude = options.claude;
    this.codex = options.codex;
    this.configResolver = options.configResolver;
  }

  private async pick(sessionName?: string): Promise<{ runner: AgentRunner; resolved: string }> {
    const resolved = await this.bridge.resolveSessionName(sessionName);
    const kind = await resolveAgentKind(this.configResolver, resolved);
    return { runner: kind === "codex" ? this.codex : this.claude, resolved };
  }

  async checkIfRunning(sessionName?: string): Promise<boolean> {
    return (await this.pick(sessionName)).runner.checkIfRunning(sessionName);
  }

  // The four lifecycle methods below maintain the running-sessions roster that
  // reboot recovery restores: start/restart/resume leave an agent running; exit
  // leaves it stopped. Marked after the runner call so a failed launch doesn't
  // record a phantom running agent.
  async start(sessionName?: string, command?: string): Promise<void> {
    const { runner, resolved } = await this.pick(sessionName);
    await runner.start(sessionName, command);
    markSessionRunning(resolved);
  }

  async startWithResume(
    sessionName: string | undefined,
    sessionId: string,
    command?: string,
  ): Promise<void> {
    const { runner, resolved } = await this.pick(sessionName);
    await runner.startWithResume(sessionName, sessionId, command);
    // We are now running this EXACT conversation id — persist it as the live id
    // so reboot recovery resumes this one, not a stale pre-resume conversation.
    // performStart records the id it assigns at a fresh launch; the resume path
    // (chat resume buttons, recovery) goes only through here, so recording at
    // this single chokepoint keeps the two paths symmetric and can't drift into
    // the adapters. Idempotent for recovery, whose id came from this same store.
    //
    // Recorded optimistically (we requested this id) rather than read back from the
    // process. Safe in practice: on chat-resume the id is the user's explicit pick
    // from a freshly-listed set of resumable conversations (so it isn't stale), and
    // on recovery the id came from this same store (idempotent). If a claude ever
    // silently falls back to --continue the recorded id can lag — the config-resolver
    // corrects it only once the agent is actively WORKING (it reads the live id from
    // the then-open transcript; claude holds none open at idle), so don't count on an
    // immediate self-heal. Given the fresh-pick + idempotent inputs, that lag is
    // acceptable and a read-back here would buy little.
    recordLiveSessionId(resolved, sessionId);
    markSessionRunning(resolved);
  }

  async waitUntilReady(sessionName?: string): Promise<void> {
    return (await this.pick(sessionName)).runner.waitUntilReady(sessionName);
  }

  async waitUntilInputReady(sessionName?: string): Promise<void> {
    return (await this.pick(sessionName)).runner.waitUntilInputReady(sessionName);
  }

  async waitUntilDone(sessionName?: string): Promise<{ done: boolean; output: string }> {
    return (await this.pick(sessionName)).runner.waitUntilDone(sessionName);
  }

  async interrupt(sessionName?: string): Promise<void> {
    return (await this.pick(sessionName)).runner.interrupt(sessionName);
  }

  async exit(sessionName?: string): Promise<void> {
    const { runner, resolved } = await this.pick(sessionName);
    await runner.exit(sessionName);
    markSessionStopped(resolved);
  }

  async gracefulRestart(sessionName?: string): Promise<void> {
    const { runner, resolved } = await this.pick(sessionName);
    await runner.gracefulRestart(sessionName);
    markSessionRunning(resolved);
  }

  async gracefulRestartWithContinue(sessionName?: string, command?: string): Promise<void> {
    const { runner, resolved } = await this.pick(sessionName);
    await runner.gracefulRestartWithContinue(sessionName, command);
    markSessionRunning(resolved);
  }
}
