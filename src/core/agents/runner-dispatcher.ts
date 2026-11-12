import { createLogger } from "../../shared/utils/logger.js";
import { sleep } from "../../shared/utils/sleep.js";
import type { TmuxBridge } from "../session/tmux.js";
import type { ConfigResolver, LiveAgentIdentity } from "./agent-config-resolver.js";
import { resolveAgentKind } from "./agentKindMap.js";
import { recordLiveSessionId } from "./live-session-id.js";
import type { AgentRunner, FreshLaunchGrant } from "./runner.js";
import { markSessionRunning, markSessionStopped, markSessionUsed } from "./runningSessions.js";

const log = createLogger("agents.runner-dispatcher");
type LaunchRegistration =
  | FreshLaunchGrant
  | {
      agentPid: null;
      issuedAt: number;
      generation: number;
      command: string | undefined;
      completion: Promise<void>;
    };

/**
 * Routes every AgentRunner call to the claude or codex backend based on which
 * agent is LIVE in the resolved session (process-detected via the config
 * resolver), falling back to the persisted launch-intent for the brief gap
 * before a freshly-started process is visible. Exposed to handlers as
 * deps.agent; every call site uses it unchanged regardless of agent.
 */
export class AgentRunnerDispatcher implements AgentRunner {
  private readonly freshLaunches = new Map<string, LaunchRegistration>();
  private launchGeneration = 0;
  private readonly bridge: TmuxBridge;
  private readonly claude: AgentRunner;
  private readonly codex: AgentRunner;
  private readonly configResolver: ConfigResolver;
  private readonly maxWaitReadyMs: number;

  constructor(options: {
    bridge: TmuxBridge;
    claude: AgentRunner;
    codex: AgentRunner;
    configResolver: ConfigResolver;
    maxWaitReadyMs: number;
  }) {
    this.bridge = options.bridge;
    this.claude = options.claude;
    this.codex = options.codex;
    this.configResolver = options.configResolver;
    this.maxWaitReadyMs = options.maxWaitReadyMs;
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
  private async identityBeforeDeadline(
    session: string,
    deadline: number,
  ): Promise<LiveAgentIdentity | null> {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || !this.configResolver.resolveLiveAgentIdentity) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.configResolver.resolveLiveAgentIdentity(session).catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), remaining);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async pickBeforeDeadline(
    sessionName: string | undefined,
    deadline: number,
  ): Promise<{ runner: AgentRunner; resolved: string }> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Agent startup readiness deadline exhausted");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.pick(sessionName),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Agent startup readiness deadline exhausted")),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async start(sessionName?: string, command?: string, deadlineAt?: number): Promise<void> {
    const startedAt = Date.now();
    const deadline = Math.min(
      startedAt + this.maxWaitReadyMs,
      deadlineAt ?? Number.POSITIVE_INFINITY,
    );
    const { runner, resolved } = await this.pickBeforeDeadline(sessionName, deadline);
    const previous = this.freshLaunches.get(resolved);
    const trusted = runner === this.codex && runner.isFreshStartCommand?.(command) === true;
    if (previous?.agentPid === null) {
      if (trusted && previous.command === command) return previous.completion;
      await previous.completion.catch(() => {});
      const completed = this.freshLaunches.get(resolved);
      if (
        !completed ||
        completed.agentPid === null ||
        completed.generation !== previous.generation
      ) {
        log.info("fresh launch registration settled", {
          session: resolved,
          data: {
            reason: "waiting-intent-invalidated",
            agentPid: completed?.agentPid ?? null,
            elapsedMs: Date.now() - startedAt,
          },
        });
        throw new Error("Agent startup intent invalidated while waiting");
      }
      return this.start(sessionName, command, deadline);
    }
    let complete!: () => void;
    let fail!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    void completion.catch(() => {});
    let registration: LaunchRegistration = previous ?? {
      agentPid: null,
      issuedAt: startedAt,
      generation: ++this.launchGeneration,
      command,
      completion,
    };
    this.freshLaunches.set(resolved, registration);
    const finish = (reason: string, agentPid: number | null = null): void => {
      if (
        reason !== "granted" &&
        reason !== "preserved-noop" &&
        this.freshLaunches.get(resolved) === registration
      )
        this.freshLaunches.delete(resolved);
      log.info("fresh launch registration settled", {
        session: resolved,
        data: { reason, agentPid, elapsedMs: Date.now() - startedAt },
      });
    };
    try {
      if (!trusted && this.freshLaunches.get(resolved) === registration)
        this.freshLaunches.delete(resolved);
      const before = trusted ? await this.identityBeforeDeadline(resolved, deadline) : null;
      const preserve =
        trusted &&
        previous?.agentPid !== null &&
        previous !== undefined &&
        before?.kind === "codex" &&
        before.agentPid === previous.agentPid &&
        before.transcript === null;
      const fresh = trusted && before?.kind === null;
      if (
        fresh &&
        registration.agentPid !== null &&
        this.freshLaunches.get(resolved) === registration
      ) {
        registration = {
          agentPid: null,
          issuedAt: startedAt,
          generation: ++this.launchGeneration,
          command,
          completion,
        };
        this.freshLaunches.set(resolved, registration);
      }
      if (!fresh && !preserve && this.freshLaunches.get(resolved) === registration)
        this.freshLaunches.delete(resolved);
      if (trusted && Date.now() >= deadline) {
        finish("deadline");
        throw new Error("Agent startup readiness deadline exhausted");
      }
      try {
        if (trusted) await runner.start(sessionName, command, deadline);
        else await runner.start(sessionName, command);
      } catch (error) {
        finish(Date.now() >= deadline ? "deadline" : "launch-failed");
        throw error;
      }
      markSessionRunning(resolved);
      markSessionUsed(resolved);
      if (!trusted) {
        finish(runner === this.codex ? "untrusted-launch" : "not-codex");
        return;
      }
      if (!fresh && !preserve) {
        finish(
          Date.now() >= deadline
            ? "deadline"
            : before === null
              ? "pre-start-unavailable"
              : before.transcript !== null
                ? "pre-start-history"
                : "pre-start-existing",
          before?.agentPid ?? null,
        );
        return;
      }
      while (Date.now() < deadline) {
        if (this.freshLaunches.get(resolved) !== registration) {
          finish("invalidated");
          return;
        }
        const after = await this.identityBeforeDeadline(resolved, deadline);
        if (Date.now() >= deadline) {
          finish("deadline");
          return;
        }
        if (this.freshLaunches.get(resolved) !== registration) {
          finish("invalidated");
          return;
        }
        if (after?.kind === "codex" && after.agentPid !== null && after.transcript === null) {
          if (preserve) {
            finish(
              after.agentPid === previous?.agentPid ? "preserved-noop" : "pid-changed",
              after.agentPid,
            );
          } else {
            this.freshLaunches.set(resolved, {
              agentPid: after.agentPid,
              issuedAt: registration.issuedAt,
              generation: registration.generation,
            });
            finish("granted", after.agentPid);
          }
          return;
        }
        if (preserve || after?.kind !== null) {
          finish(
            after?.transcript ? "history-open" : "identity-unavailable",
            after?.agentPid ?? null,
          );
          return;
        }
        await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
      }
      finish("deadline");
    } catch (error) {
      fail(error);
      throw error;
    } finally {
      complete();
    }
  }

  consumeFreshLaunch(session: string, expectedPid: number): FreshLaunchGrant | null {
    const grant = this.freshLaunches.get(session);
    this.freshLaunches.delete(session);
    return grant?.agentPid !== null && grant?.agentPid === expectedPid ? grant : null;
  }

  async startWithResume(
    sessionName: string | undefined,
    sessionId: string,
    command?: string,
  ): Promise<void> {
    const { runner, resolved } = await this.pick(sessionName);
    this.freshLaunches.delete(resolved);
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
    markSessionUsed(resolved);
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
    this.freshLaunches.delete(resolved);
    await runner.exit(sessionName);
    markSessionStopped(resolved);
  }

  async gracefulRestart(sessionName?: string): Promise<void> {
    const { runner, resolved } = await this.pick(sessionName);
    this.freshLaunches.delete(resolved);
    await runner.gracefulRestart(sessionName);
    markSessionRunning(resolved);
    markSessionUsed(resolved);
  }

  async gracefulRestartWithContinue(sessionName?: string, command?: string): Promise<void> {
    const { runner, resolved } = await this.pick(sessionName);
    this.freshLaunches.delete(resolved);
    await runner.gracefulRestartWithContinue(sessionName, command);
    markSessionRunning(resolved);
    markSessionUsed(resolved);
  }
}
