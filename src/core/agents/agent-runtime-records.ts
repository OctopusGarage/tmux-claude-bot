import type { AgentKind } from "../../shared/types.js";
import { clearAgentKind, getAgentKind, setAgentKind } from "./agentKindMap.js";
import {
  clearLiveSessionId,
  getLastLiveSessionId,
  recordLiveSessionId,
} from "./live-session-id.js";
import { clearStartCommand, getStartCommand, setStartCommand } from "./startCommandMap.js";

export type AgentRuntimeRecord = {
  kind: AgentKind;
  startCommand: string | null;
  liveSessionId: string | null;
};

export type AgentLaunchRecord = {
  kind: AgentKind;
  startCommand: string;
  liveSessionId?: string | null;
};

export function getAgentRuntimeRecord(session: string): AgentRuntimeRecord {
  return {
    kind: getAgentKind(session),
    startCommand: getStartCommand(session),
    liveSessionId: getLastLiveSessionId(session),
  };
}

export function recordAgentLaunch(session: string, record: AgentLaunchRecord): void {
  setAgentKind(session, record.kind);
  setStartCommand(session, record.startCommand);
  if (record.liveSessionId === null) {
    clearLiveSessionId(session);
  } else if (record.liveSessionId) {
    recordLiveSessionId(session, record.liveSessionId);
  }
}

export function clearAgentRuntimeRecord(session: string): void {
  clearLiveSessionId(session);
  clearAgentKind(session);
  clearStartCommand(session);
}
