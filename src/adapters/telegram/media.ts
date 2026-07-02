import { type Bot, InputFile } from "grammy";
import type { AttachmentKind } from "../../core/attachments/classify.js";

type TelegramApi = Pick<Bot["api"], "sendPhoto" | "sendDocument">;

export async function sendTelegramAttachment(
  api: TelegramApi,
  chatId: string,
  filePath: string,
  kind: AttachmentKind,
  caption?: string,
): Promise<void> {
  const id = Number(chatId);
  if (!chatId || !Number.isInteger(id)) throw new Error(`invalid telegram chatId: ${chatId}`);
  const file = new InputFile(filePath);
  const extra = caption !== undefined ? { caption } : {};
  if (kind === "image") await api.sendPhoto(id, file, extra);
  else await api.sendDocument(id, file, extra);
}
