export const MESSAGE_ACTIONS = [
  "text",
  "start",
  "resume",
  "exit",
  "restart",
  "esc",
  "interrupt",
  "clear",
  "compact",
  "enter",
  "up",
  "down",
  "left",
  "right",
  "tab",
  "status",
] as const;

export type MessageAction = (typeof MESSAGE_ACTIONS)[number];

export function isMessageAction(action: string): action is MessageAction {
  return (MESSAGE_ACTIONS as readonly string[]).includes(action);
}

export type ActionPrecondition = "running" | "absent" | null;

/**
 * Precondition each action requires of the live agent, enforced by dispatch:
 *   "running" — needs a live agent because acting on a bare shell is harmful or
 *               confusing: a prompt or a "/clear" typed into a shell RUNS as a
 *               shell command, and there's nothing to exit.
 *   "absent"  — must have NO live agent (start would spawn a second one).
 *   null      — tolerant. Raw keys and interrupts are harmless on a bare pane AND
 *               are the user's escape hatch precisely when agent-state is uncertain
 *               (a startup prompt, a stuck pane) — guarding them would block it.
 *               restart resumes whether alive or dead; status is read-only.
 */
const ACTION_PRECONDITION: Record<MessageAction, ActionPrecondition> = {
  text: "running",
  start: "absent",
  resume: "absent",
  exit: "running",
  clear: "running",
  compact: "running",
  restart: null,
  esc: null,
  interrupt: null,
  enter: null,
  up: null,
  down: null,
  left: null,
  right: null,
  tab: null,
  status: null,
};

export function getActionPrecondition(action: MessageAction): ActionPrecondition {
  return ACTION_PRECONDITION[action];
}
