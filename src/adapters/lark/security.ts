import type { CardActionEvent, LarkChannel, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { runRemoteIngress } from "../../core/security/ingress.js";
import { isOpenIdAllowed } from "./auth.js";
import { verifyValue } from "./card-signing.js";
import { sendText } from "./replies.js";

export function secureLarkMessage(
  channel: LarkChannel,
  deps: HandlerDeps,
  handle: (msg: NormalizedMessage) => Promise<void>,
) {
  return async (msg: NormalizedMessage): Promise<void> => {
    if (!isOpenIdAllowed(msg.senderId, deps.config.lark?.allowedOpenIds ?? new Set())) {
      deps.securityAlerts?.record("lark", "identity");
      return;
    }
    await runRemoteIngress({
      service: deps.remoteAccess,
      alerts: deps.securityAlerts,
      principal: { channel: "lark", userId: msg.senderId, chatId: msg.chatId },
      privateChat: msg.chatType === "p2p",
      text:
        msg.rawContentType === "text" || msg.rawContentType === "post" ? msg.content : undefined,
      reply: (text) => sendText(channel, msg.chatId, text),
      sendPrivate: (text) => sendText(channel, msg.senderId, text),
      removeSensitive: () => channel.recallMessage(msg.messageId),
      run: () => handle(msg),
    });
  };
}

export function secureLarkCard(
  channel: LarkChannel,
  deps: HandlerDeps,
  handle: (evt: CardActionEvent) => Promise<void>,
) {
  return async (evt: CardActionEvent): Promise<void> => {
    if (!isOpenIdAllowed(evt.operator.openId, deps.config.lark?.allowedOpenIds ?? new Set())) {
      deps.securityAlerts?.record("lark", "identity");
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- malformed SDK events can omit action at runtime
    if (!verifyValue(evt.action?.value)) {
      deps.securityAlerts?.record("lark", "authorization");
      return;
    }
    await runRemoteIngress({
      service: deps.remoteAccess,
      alerts: deps.securityAlerts,
      principal: { channel: "lark", userId: evt.operator.openId, chatId: evt.chatId },
      privateChat: false,
      reply: (text) => sendText(channel, evt.chatId, text),
      sendPrivate: (text) => sendText(channel, evt.operator.openId, text),
      run: () => handle(evt),
    });
  };
}
