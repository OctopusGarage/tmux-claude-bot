import { recordReplyTarget } from "../projects/session-reply-target.js";
import { taskEnded, taskStarted } from "../session/task-timing.js";
import type { QueuedMessage } from "./queue-message.js";
import { replyTargetFromMessage } from "./reply-target-from-message.js";

export interface QueueObserver {
  started(sessionName: string, msg: QueuedMessage): void;
  finished(sessionName: string, msg: QueuedMessage): void;
}

export const defaultQueueObserver: QueueObserver = {
  started(sessionName, msg) {
    taskStarted(sessionName);
    const target = replyTargetFromMessage(msg);
    if (target) recordReplyTarget(sessionName, target);
  },
  finished(sessionName) {
    taskEnded(sessionName);
  },
};
