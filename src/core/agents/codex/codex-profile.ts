import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { buildCodexResumeCommand } from "../resume-command.js";
import type { AgentProfile, AgentTurnCompletion, ReadResolver } from "../types.js";
import { parseCodexFlavorAliases } from "./codex-flavor-alias.js";
import {
  getLatestCodexReply,
  getRecentCodexConversations,
  listCodexSessions,
  readCodexTurnCompletion,
} from "./codex-history.js";
import { isCodexProcess } from "./codex-process.js";
import { findRolloutForProject, readFirstLine } from "./codex-rollout.js";
import { buildCodexStatusReport } from "./codex-status.js";
import { readCodexUsage } from "./codex-usage.js";

const DEFAULT_CODEX_ROOT = `${homedir()}/.codex`;

/** A codex session's transcript source: its CODEX_HOME, and the rollout the LIVE
 * pid currently has open (exact under same-cwd Free-Projects contention, else the
 * read funcs fall back to the newest cwd-matched rollout).
 *
 * `CODEX_HOME` is often unset because Codex defaults to ~/.codex. The live rollout
 * is already an absolute path from the running pid, so do not gate it on a
 * resolved env var; otherwise /history returns empty for normal default installs.
 */
async function codexSource(
  resolver: ReadResolver,
  session: string,
): Promise<{ home: string | null; rolloutPath: string | null }> {
  const home = (await resolver.resolveCodexHome?.(session)) ?? null;
  const live = (await resolver.resolveLiveTranscript?.(session)) ?? null;
  return {
    home: home ?? (live ? DEFAULT_CODEX_ROOT : null),
    rolloutPath: live?.path ?? null,
  };
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
  // Mirror the codex /status usage resolution: resolve CODEX_HOME (null when no
  // codex runs → no usage), prefer the live pid's open rollout (exact under
  // same-cwd contention; else readCodexUsage falls back to the newest cwd-matched
  // rollout), then parse usage from the rollout JSONL tail.
  readUsage: async (resolver, session, projectPath) => {
    const home = (await resolver.resolveCodexHome?.(session)) ?? null;
    if (!home) return null;
    const live = (await resolver.resolveLiveTranscript?.(session)) ?? null;
    return readCodexUsage({
      sessionId: live?.sessionId ?? "",
      configRoot: home,
      projectPath,
      rolloutPath: live?.path ?? null,
    });
  },
  // Newest cwd-matched rollout's mtime — codex appends to its rollout JSONL as it
  // streams, so its mtime is the last-write time (works regardless of who drove it).
  lastActivityAt: async (resolver, session, projectPath) => {
    const home = (await resolver.resolveCodexHome?.(session)) ?? null;
    if (!home) return null;
    const match = await findRolloutForProject(home, projectPath);
    if (!match) return null;
    try {
      return (await stat(match.path)).mtimeMs;
    } catch {
      return null;
    }
  },
  resolveTranscriptPath: async (resolver, session, projectPath) => {
    const { home, rolloutPath } = await codexSource(resolver, session);
    if (rolloutPath) return rolloutPath;
    return home ? ((await findRolloutForProject(home, projectPath))?.path ?? null) : null;
  },
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
  getTurnCompletion: async (resolver, session, sentText, sentAfter, cursor, options) => {
    const unavailable = { status: "unavailable" as const, output: "" };
    const freshLive = async (expected = cursor) => {
      const live = await resolver.resolveLiveTranscript?.(session, { fresh: true });
      if (!live?.sessionId || live.agentPid === undefined) return null;
      if (
        expected &&
        (expected.agentPid !== live.agentPid ||
          expected.path !== live.path ||
          expected.sessionId !== live.sessionId)
      )
        return null;
      return { ...live, agentPid: live.agentPid, sessionId: live.sessionId };
    };
    const revalidateTerminal = async (
      result: AgentTurnCompletion,
    ): Promise<AgentTurnCompletion> => {
      if (result.status !== "completed" && result.status !== "aborted") return result;
      const bound = result.cursor;
      if (!bound || !(await freshLive(bound))) return unavailable;
      return readCodexTurnCompletion(bound.path, bound.sessionId, sentText, sentAfter, bound);
    };
    if (cursor?.bootstrapIssuedAt !== undefined) {
      const identity = await resolver.resolveLiveAgentIdentity?.(session);
      if (identity?.kind !== "codex" || identity.agentPid !== cursor.agentPid) return unavailable;
      const live = identity.transcript;
      if (!live) return { status: "pending", output: "", cursor };
      if (!live.sessionId) return unavailable;
      try {
        const header = JSON.parse(await readFirstLine(live.path)) as { timestamp?: string };
        if (!(Date.parse(header.timestamp ?? "") >= cursor.bootstrapIssuedAt)) return unavailable;
      } catch {
        return unavailable;
      }
      const bound = await readCodexTurnCompletion(live.path, live.sessionId, sentText, sentAfter);
      if (bound.cursor) bound.cursor.agentPid = cursor.agentPid;
      return revalidateTerminal(bound);
    }

    if (!cursor) {
      const live = await freshLive();
      if (!live) return unavailable;
      const result = await readCodexTurnCompletion(live.path, live.sessionId, sentText, sentAfter);
      if (result.cursor) result.cursor.agentPid = live.agentPid;
      return result;
    }
    if (cursor.agentPid === undefined || (options?.fresh && !(await freshLive())))
      return unavailable;
    let result = await readCodexTurnCompletion(
      cursor.path,
      cursor.sessionId,
      sentText,
      sentAfter,
      cursor,
    );
    result = await revalidateTerminal(result);
    if (result.cursor) result.cursor.agentPid = cursor.agentPid;
    return result;
  },
  buildStatusReport: (deps, session, channel, running) =>
    buildCodexStatusReport(deps, session, channel, running),
};
