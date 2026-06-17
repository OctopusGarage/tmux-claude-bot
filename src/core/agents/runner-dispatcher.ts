import type { TmuxBridge } from "../session/tmux.js";
import type { ConfigResolver } from "./agent-config-resolver.js";
import { resolveAgentKind } from "./agentKindMap.js";
import type { AgentRunner } from "./runner.js";

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

  private async pick(sessionName?: string): Promise<AgentRunner> {
    const resolved = await this.bridge.resolveSessionName(sessionName);
    const kind = await resolveAgentKind(this.configResolver, resolved);
    return kind === "codex" ? this.codex : this.claude;
  }

  async checkIfRunning(sessionName?: string): Promise<boolean> {
    return (await this.pick(sessionName)).checkIfRunning(sessionName);
  }

  async start(sessionName?: string, command?: string): Promise<void> {
    return (await this.pick(sessionName)).start(sessionName, command);
  }

  async startWithResume(sessionName: string | undefined, sessionId: string): Promise<void> {
    return (await this.pick(sessionName)).startWithResume(sessionName, sessionId);
  }

  async waitUntilReady(sessionName?: string): Promise<void> {
    return (await this.pick(sessionName)).waitUntilReady(sessionName);
  }

  async waitUntilDone(sessionName?: string): Promise<{ done: boolean; output: string }> {
    return (await this.pick(sessionName)).waitUntilDone(sessionName);
  }

  async interrupt(sessionName?: string): Promise<void> {
    return (await this.pick(sessionName)).interrupt(sessionName);
  }

  async exit(sessionName?: string): Promise<void> {
    return (await this.pick(sessionName)).exit(sessionName);
  }

  async gracefulRestart(sessionName?: string): Promise<void> {
    return (await this.pick(sessionName)).gracefulRestart(sessionName);
  }

  async gracefulRestartWithContinue(sessionName?: string, command?: string): Promise<void> {
    return (await this.pick(sessionName)).gracefulRestartWithContinue(sessionName, command);
  }
}
