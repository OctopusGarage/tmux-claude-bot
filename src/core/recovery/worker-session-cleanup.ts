import { clearAgentRuntimeRecord } from "../agents/agent-runtime-records.js";
import { markSessionStopped } from "../agents/runningSessions.js";
import { clearPicker } from "../autopilot/picker-state.js";
import { clearReplyTarget } from "../projects/session-reply-target.js";
import { clearPathForSession } from "../projects/sessionPathMap.js";
import { clearTaskTiming } from "../session/task-timing.js";

export function cleanupWorkerSessionRecords(sessionName: string): void {
  clearAgentRuntimeRecord(sessionName);
  clearTaskTiming(sessionName);
  clearPathForSession(sessionName);
  clearPicker(sessionName);
  markSessionStopped(sessionName);
  clearReplyTarget(sessionName);
}
