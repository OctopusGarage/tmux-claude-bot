import type { HandlerDeps } from "../deps.js";
import { getActionQueuePolicy, requiresActionConfirmation } from "./action-registry.js";
import { isMessageAction, type MessageAction } from "./actions.js";
import { startDisposition } from "./dispatch.js";

export type PlannedMessageAction =
  | { kind: "confirm"; action: MessageAction }
  | { kind: "already-running"; action: "start" }
  | { kind: "pick-start-command"; action: "start" | "restart" }
  | { kind: "immediate"; action: MessageAction }
  | { kind: "queued"; action: MessageAction; text: string }
  | { kind: "no-session"; action: MessageAction }
  | { kind: "unsupported"; action: string };

export interface MessageActionPlanRequest {
  deps: HandlerDeps;
  action: string;
  session?: string | null | undefined;
  text?: string | undefined;
  confirmed?: boolean | undefined;
  /**
   * Lark can render a flavor picker from a card before a project session has been
   * selected. Other adapters should keep the stricter no-session result.
   */
  allowStartPickerWithoutSession?: boolean | undefined;
}

/**
 * Protocol-neutral decision for an agent-control action. Adapters own I/O
 * (toasts, cards, queue acks), while this module owns the shared action policy:
 * confirmation, start/restart flavor picking, and immediate-vs-queued routing.
 */
export async function planMessageAction(
  req: MessageActionPlanRequest,
): Promise<PlannedMessageAction> {
  if (!isMessageAction(req.action)) return { kind: "unsupported", action: req.action };

  const action = req.action;
  if (!req.confirmed && requiresActionConfirmation(action)) {
    return { kind: "confirm", action };
  }

  const queuePolicy = action === "text" ? "queued" : getActionQueuePolicy(action);
  if (queuePolicy === null) return { kind: "unsupported", action };

  if (queuePolicy === "immediate") return { kind: "immediate", action };

  if (action === "start" || action === "restart") {
    if (!req.session) {
      if (req.allowStartPickerWithoutSession && req.deps.config.startCommands.length > 1) {
        return { kind: "pick-start-command", action };
      }
      return { kind: "no-session", action };
    }

    const disposition = await startDisposition(req.deps, req.session, action);
    if (disposition === "already-running") return { kind: "already-running", action: "start" };
    if (disposition === "pick") return { kind: "pick-start-command", action };
  }

  return { kind: "queued", action, text: req.text ?? action };
}
