import type { HandlerDeps } from "../deps.js";
import type { Channel } from "../projects/project-manager.js";
import type { ConversationRound, SessionEntry } from "../read/transcript.js";
import type { UsageSnapshot } from "../read/usage.js";
import type { FlavorAlias } from "./flavor-alias.js";

export type { AgentKind } from "../../shared/types.js";

import type { AgentKind } from "../../shared/types.js";

/**
 * Structural shape of the bits of `ConfigResolver` the read-side needs to resolve
 * a session's transcript source (config root/home, and for codex the live pid's
 * open rollout). Typed here structurally (rather than importing `ConfigResolver`)
 * so `types.ts` stays import-light and free of a cycle with `agent-config-resolver`.
 */
export type ReadResolver = {
  resolveConfigRoot(session: string): Promise<string>;
  resolveCodexHome?(session: string): Promise<string | null>;
  /** The transcript the live agent (claude or codex) holds open, for exact
   * same-cwd resolution; the read methods fall back to newest-on-disk when null.
   * `sessionId` is the transcript/rollout id (null when the pid holds the file
   * open but the id can't be read). */
  resolveLiveTranscript?(
    session: string,
  ): Promise<{ path: string; sessionId: string | null } | null>;
};

/**
 * Per-agent strategy. Captures ONLY what differs between claude and codex.
 * `claudeProfile` is a façade delegating to the existing claude modules
 * (verbatim); `codexProfile` is all-new. Methods are added here only when a
 * capability actually needs them — keep this lean.
 */
export interface AgentProfile {
  readonly kind: AgentKind;
  /** argv0-basename test: does this running process belong to this agent? */
  matchesProcess(command: string): boolean;
  /** Env var holding the agent's config root: CLAUDE_CONFIG_DIR / CODEX_HOME. */
  readonly configDirEnv: string;
  /** Agent's default config root when the env var is unset (~/.claude / ~/.codex). */
  readonly defaultConfigRoot: string;
  /** Parse this agent's launcher aliases (`claude-*` / `codex-*`) from rc text. */
  parseFlavorAliases(rcText: string, home: string): FlavorAlias[];
  /** Base URL the orphan's process env declares, for flavor-alias matching.
   * Claude parses ANTHROPIC_BASE_URL; codex has no base-url env (always null). */
  baseUrlFromEnv(psEnv: string): string | null;
  /** Resume session id for an orphan. Claude: the session this pid holds open
   * (`openSession`) else the newest on-disk session for the project. Codex:
   * `openSession` else the newest cwd-matched rollout id. Null ⇒ start fresh. */
  discoverSessionId(o: {
    openSession: string | null;
    cwd: string;
    configRoot: string;
  }): Promise<string | null>;
  /** Build the tmux command to (re)start/resume this agent in a takeover. A
   * matched flavor `aliasName` relaunches with the flavor's own env (no secret
   * read/printed); else a reconstructed command carrying the original's flags. */
  buildResumeCommand(o: {
    aliasName: string | null;
    bin: string;
    configRoot: string;
    sessionId: string | null;
    origCmd: string;
  }): string;
  /** Recent conversation rounds for the project, newest-first. Each profile
   * resolves its OWN transcript source from the resolver — claude: config root +
   * newest session; codex: the live pid's open rollout, else the newest
   * cwd-matched one (so same-cwd Free Projects don't cross-attribute). */
  getRecentConversations(
    resolver: ReadResolver,
    session: string,
    projectPath: string,
  ): Promise<ConversationRound[]>;
  /** Saved session ids for the project, newest-first. */
  listSessions(
    resolver: ReadResolver,
    session: string,
    projectPath: string,
  ): Promise<SessionEntry[]>;
  /** Latest assistant reply to `sentText` from the session's live transcript, or
   * null (the executor then falls back to the pane snapshot). */
  getLatestReply(
    resolver: ReadResolver,
    session: string,
    projectPath: string,
    sentText: string,
  ): Promise<string | null>;
  /** Structured current usage for a session (context %, rate limits), or null when
   * none is available. Used by the dashboard; mirrors the /status usage resolution. */
  readUsage(
    resolver: ReadResolver,
    session: string,
    projectPath: string,
  ): Promise<UsageSnapshot | null>;
  /** When this session's transcript was last written (epoch ms), or null when no
   * transcript is found. A process-independent "agent wrote output recently"
   * signal: unlike the bot-queue task timer, it sees work driven directly in the
   * pane too, so the dashboard can mark such sessions busy. Optional so fakes
   * need not implement it. */
  lastActivityAt?(
    resolver: ReadResolver,
    session: string,
    projectPath: string,
  ): Promise<number | null>;
  /** /status body for a session: running state + this agent's usage/api lines. */
  buildStatusReport(
    deps: HandlerDeps,
    session: string,
    channel: Channel,
    running: boolean,
  ): Promise<string>;
}
