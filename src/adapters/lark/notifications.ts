import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { boundLarkGroupForSession } from "../../core/notifications/target-resolver.js";
import { opportunityDigestCard } from "./cards.js";
import { type LarkMediaClient, sendLarkAttachment } from "./media.js";
import { sendCard, sendText } from "./replies.js";
import { clientFor, notifyLarkOwner, notifyLarkOwnerCard } from "./resource.js";

type LarkConfig = NonNullable<HandlerDeps["config"]["lark"]>;

export function registerLarkNotifications(
  deps: HandlerDeps,
  cfg: LarkConfig,
  channel: LarkChannel,
): void {
  if ([...cfg.allowedOpenIds][0] !== undefined) {
    deps.notifications.register("lark", async (message, req) => {
      const target = boundLarkGroupForSession(req?.session);
      const card =
        req?.source === "opportunity-discovery" && req.opportunities?.length
          ? opportunityDigestCard({
              title: req.title,
              body: req.body ?? message,
              opportunities: req.opportunities,
            })
          : null;
      if (card !== null) {
        if (target) {
          await sendCard(channel, target.chatId, card);
          return;
        }
        await notifyLarkOwnerCard(cfg, card);
        return;
      }
      if (target) {
        await sendText(channel, target.chatId, message);
        return;
      }
      await notifyLarkOwner(cfg, message);
    });
    deps.notifications.registerAttachment("lark", (filePath, kind, caption, req) => {
      const target = boundLarkGroupForSession(req?.session);
      return sendLarkAttachment(
        clientFor(cfg) as unknown as LarkMediaClient,
        target?.chatId ?? [...cfg.allowedOpenIds][0] ?? "",
        filePath,
        kind,
        caption,
        undefined,
        target ? undefined : "open_id",
      );
    });
  }

  deps.channelSenders.register("lark", (chatId, filePath, kind, caption) =>
    sendLarkAttachment(
      clientFor(cfg) as unknown as LarkMediaClient,
      chatId,
      filePath,
      kind,
      caption,
    ),
  );
}
