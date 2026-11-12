import type { HandlerDeps } from "../deps.js";
import type { Channel } from "../projects/project-manager.js";
import type { ConversationRound, SessionEntry } from "../read/transcript.js";
import type { ConfigResolver } from "./agent-config-resolver.js";
import { resolveAgentKind } from "./agentKindMap.js";
import { profileFor } from "./registry.js";
import type { AgentTurnCompletion, AgentTurnCursor, ReadResolver } from "./types.js";

export type AgentReadResolver = ReadResolver & Pick<ConfigResolver, "detectAgentKind">;

async function readProfile(resolver: AgentReadResolver, session: string) {
  return profileFor(await resolveAgentKind(resolver, session));
}

export async function readAgentRecentConversations(
  resolver: AgentReadResolver,
  session: string,
  projectPath: string,
): Promise<ConversationRound[]> {
  const profile = await readProfile(resolver, session);
  return profile.getRecentConversations(resolver, session, projectPath);
}

export async function readAgentLatestReply(
  resolver: AgentReadResolver,
  session: string,
  projectPath: string,
  sentText: string,
): Promise<string | null> {
  const profile = await readProfile(resolver, session);
  return profile.getLatestReply(resolver, session, projectPath, sentText);
}

export async function readAgentTurnCompletion(
  resolver: AgentReadResolver,
  session: string,
  sentText: string,
  sentAfter: number,
  cursor?: AgentTurnCursor,
  options?: { fresh?: boolean },
): Promise<AgentTurnCompletion | null> {
  const profile = await readProfile(resolver, session);
  return (
    profile.getTurnCompletion?.(resolver, session, sentText, sentAfter, cursor, options) ?? null
  );
}

export async function readAgentSessions(
  resolver: AgentReadResolver,
  session: string,
  projectPath: string,
): Promise<SessionEntry[]> {
  const profile = await readProfile(resolver, session);
  return profile.listSessions(resolver, session, projectPath);
}

export async function readAgentLastActivityAt(
  resolver: AgentReadResolver,
  session: string,
  projectPath: string,
): Promise<number | null> {
  const profile = await readProfile(resolver, session);
  return (await profile.lastActivityAt?.(resolver, session, projectPath)) ?? null;
}

export async function buildAgentStatusReport(
  deps: HandlerDeps,
  session: string,
  channel: Channel,
  running: boolean,
): Promise<string> {
  const profile = await readProfile(deps.configResolver, session);
  return profile.buildStatusReport(deps, session, channel, running);
}
