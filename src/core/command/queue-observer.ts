import { markSessionUsed } from "../agents/runningSessions.js";
import { recordReplyTarget } from "../projects/session-reply-target.js";
import { clearRecoveryIntent, markRecoveryIntent } from "../recovery/recovery-intent.js";
import { taskEnded, taskStarted } from "../session/task-timing.js";
import type { QueuedMessage } from "./queue-message.js";
import { replyTargetFromMessage } from "./reply-target-from-message.js";

export interface QueueObserver {
  started(sessionName: string, msg: QueuedMessage): void;
  finished(sessionName: string, msg: QueuedMessage): void;
}

export const defaultQueueObserver: QueueObserver = {
  started(sessionName, msg) {
    markSessionUsed(sessionName);
    // Only prompt-bearing work can require conversation recovery. Control
    // actions such as status/esc/restart are short-lived operations and must
    // never authorize a later boot-time resume.
    if (msg.action === "text") markRecoveryIntent(sessionName, msg.id);
    taskStarted(sessionName);
    const target = replyTargetFromMessage(msg);
    if (target) recordReplyTarget(sessionName, target);
  },
  finished(sessionName, msg) {
    markSessionUsed(sessionName);
    if (msg.action === "text") clearRecoveryIntent(sessionName, msg.id);
    taskEnded(sessionName);
  },
};
