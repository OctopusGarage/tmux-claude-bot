import { parseEnvVar } from "../agent-config-resolver.js";
import { getLastLiveSessionId } from "../live-session-id.js";
import { buildResumeCommand, SKIP_PERMS } from "../resume-command.js";
import type { AgentProfile } from "../types.js";
import { parseClaudeFlavorAliases } from "./claude-flavor-alias.js";
import {
  DEFAULT_CONFIG_ROOT,
  getLatestAssistantReply,
  getRecentConversations,
  listClaudeSessions,
} from "./claude-history.js";
import { isClaudeProcess } from "./claude-process.js";
import { buildStatusReport, readUsageSnapshot } from "./claude-status.js";

/** Façade over the existing (untouched) claude modules. */
export const claudeProfile: AgentProfile = {
  kind: "claude",
  matchesProcess: isClaudeProcess,
  configDirEnv: "CLAUDE_CONFIG_DIR",
  defaultConfigRoot: DEFAULT_CONFIG_ROOT,
  parseFlavorAliases: parseClaudeFlavorAliases,
  baseUrlFromEnv: (psEnv) => parseEnvVar(psEnv, "ANTHROPIC_BASE_URL"),
  // Prefer the session this PID actually has open (exact); fall back to the
  // newest on disk when it isn't holding the file open between turns.
  discoverSessionId: async ({ openSession, cwd, configRoot }) =>
    openSession ?? (await listClaudeSessions(cwd, configRoot, 1))[0]?.sessionId ?? null,
  // A matched flavor alias relaunches with the flavor's full env straight from
  // the rc file; else reconstruct, carrying over the original's yolo flag.
  buildResumeCommand: ({ aliasName, bin, configRoot, sessionId, origCmd }) =>
    aliasName
      ? `${aliasName}${sessionId ? ` --resume ${sessionId}` : ""}`
      : buildResumeCommand(bin, {
          configRoot,
          sessionId,
          skipPermissions: origCmd.includes(SKIP_PERMS),
        }),
  getRecentConversations: async (resolver, session, projectPath) => {
    const [configRoot, live] = await Promise.all([
      resolver.resolveConfigRoot(session),
      resolver.resolveLiveTranscript?.(session),
    ]);
    return getRecentConversations(projectPath, configRoot, live?.path ?? null);
  },
  listSessions: async (resolver, session, projectPath) =>
    listClaudeSessions(projectPath, await resolver.resolveConfigRoot(session)),
  getLatestReply: async (resolver, session, projectPath, sentText) => {
    const [configRoot, live] = await Promise.all([
      resolver.resolveConfigRoot(session),
      resolver.resolveLiveTranscript?.(session),
    ]);
    return getLatestAssistantReply(projectPath, sentText, configRoot, live?.path ?? null);
  },
  // Mirror the claude /status usage resolution: prefer the session id the live
  // pid holds open (exact under same-cwd contention), else the persisted
  // last-observed id; then read that session's statusLine snapshot.
  readUsage: async (resolver, session) => {
    const live = await resolver.resolveLiveTranscript?.(session);
    const sessionId = live?.sessionId ?? getLastLiveSessionId(session);
    return sessionId ? readUsageSnapshot(sessionId) : null;
  },
  // Newest transcript mtime for this project — claude appends to
  // projects/<dir>/<uuid>.jsonl as it streams, so its mtime is the last-write time.
  lastActivityAt: async (resolver, session, projectPath) => {
    const configRoot = await resolver.resolveConfigRoot(session);
    const [newest] = await listClaudeSessions(projectPath, configRoot, 1);
    return newest ? newest.mtime.getTime() : null;
  },
  buildStatusReport: (deps, session, channel, running) =>
    buildStatusReport(deps, session, channel, running),
};
