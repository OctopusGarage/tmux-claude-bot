import type { AttachmentKind } from "../attachments/classify.js";

export type ChannelSendFn = (
  chatId: string,
  filePath: string,
  kind: AttachmentKind,
  caption?: string,
) => Promise<void>;

export class ChannelSenderRegistry {
  private readonly senders = new Map<"telegram" | "lark", ChannelSendFn>();

  register(channel: "telegram" | "lark", fn: ChannelSendFn): void {
    this.senders.set(channel, fn);
  }

  async send(
    channel: "telegram" | "lark",
    chatId: string,
    filePath: string,
    kind: AttachmentKind,
    caption?: string,
  ): Promise<void> {
    const fn = this.senders.get(channel);
    if (!fn) throw new Error(`no sender registered for ${channel}`);
    await fn(chatId, filePath, kind, caption);
  }
}
