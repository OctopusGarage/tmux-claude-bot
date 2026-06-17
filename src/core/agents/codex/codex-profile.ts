import { homedir } from "node:os";
import { buildCodexResumeCommand } from "../resume-command.js";
import type { AgentProfile, ReadResolver } from "../types.js";
import { parseCodexFlavorAliases } from "./codex-flavor-alias.js";
import {
  getLatestCodexReply,
  getRecentCodexConversations,
  listCodexSessions,
} from "./codex-history.js";
import { isCodexProcess } from "./codex-process.js";
import { findRolloutForProject } from "./codex-rollout.js";
import { buildCodexStatusReport } from "./codex-status.js";

const DEFAULT_CODEX_ROOT = `${homedir()}/.codex`;

/** A codex session's transcript source: its CODEX_HOME, and the rollout the LIVE
 * pid currently has open (exact under same-cwd Free-Projects contention, else the
 * read funcs fall back to the newest cwd-matched rollout). `home` is null when no
 * codex runs → the read methods return empty, same as before. */
async function codexSource(
  resolver: ReadResolver,
  session: string,
): Promise<{ home: string | null; rolloutPath: string | null }> {
  const home = (await resolver.resolveCodexHome?.(session)) ?? null;
  const rolloutPath = home
    ? ((await resolver.resolveLiveTranscript?.(session))?.path ?? null)
    : null;
  return { home, rolloutPath };
}

/** Codex profile. */
export const codexProfile: AgentProfile = {
  kind: "codex",
  matchesProcess: isCodexProcess,
  configDirEnv: "CODEX_HOME",
  defaultConfigRoot: DEFAULT_CODEX_ROOT,
  parseFlavorAliases: parseCodexFlavorAliases,
  // Codex has no base-url env (auths via auth.json); always null.
  baseUrlFromEnv: () => null,
  // Prefer the rollout this pid actually has open (exact under same-cwd
  // contention — `openSessionFile` now matches codex rollouts too); fall back to
  // the newest cwd-matched rollout when the pid isn't holding one open.
  discoverSessionId: async ({ openSession, cwd, configRoot }) =>
    openSession ?? (await findRolloutForProject(configRoot, cwd))?.sessionId ?? null,
  buildResumeCommand: ({ aliasName, configRoot, sessionId, origCmd }) =>
    buildCodexResumeCommand({ aliasName, configRoot, sessionId, origCmd }),
  getRecentConversations: async (resolver, session, projectPath) => {
    const { home, rolloutPath } = await codexSource(resolver, session);
    return home ? getRecentCodexConversations(home, projectPath, undefined, rolloutPath) : [];
  },
  listSessions: async (resolver, session, projectPath) => {
    const home = (await resolver.resolveCodexHome?.(session)) ?? null;
    return home ? listCodexSessions(home, projectPath) : [];
  },
  getLatestReply: async (resolver, session, projectPath, sentText) => {
    const { home, rolloutPath } = await codexSource(resolver, session);
    return home ? getLatestCodexReply(home, projectPath, sentText, rolloutPath) : null;
  },
  buildStatusReport: (deps, session, channel, running) =>
    buildCodexStatusReport(deps, session, channel, running),
};
