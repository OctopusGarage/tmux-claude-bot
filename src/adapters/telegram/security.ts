import type { Context, NextFunction } from "grammy";
import type { SecurityAlerts } from "../../core/security/alerts.js";
import { runRemoteIngress } from "../../core/security/ingress.js";
import type { RemoteAccessService } from "../../core/security/remote-access.js";

export function createRemoteAccessGuard(service?: RemoteAccessService, alerts?: SecurityAlerts) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    if (!service) return next();
    if (!ctx.from || !ctx.chat) return;
    const userId = ctx.from.id;
    const passed = await runRemoteIngress({
      service,
      alerts,
      principal: { channel: "telegram", userId: String(ctx.from.id), chatId: String(ctx.chat.id) },
      privateChat: ctx.chat.type === "private",
      text: ctx.message?.text,
      reply: (text) => ctx.reply(text),
      sendPrivate: (text) => ctx.api.sendMessage(userId, text),
      removeSensitive: () => ctx.deleteMessage(),
      run: async () => {
        await next();
      },
    });
    if (!passed && ctx.callbackQuery) {
      try {
        await ctx.answerCallbackQuery();
      } catch {
        /* Expired callback; denial still holds. */
      }
    }
  };
}
