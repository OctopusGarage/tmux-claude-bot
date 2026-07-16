import { createReadStream } from "node:fs";
import { basename } from "node:path";
import type { AttachmentKind } from "../../core/attachments/classify.js";

export type LarkMediaClient = {
  im: {
    v1: {
      // The Lark SDK returns the key at the TOP LEVEL of the response (it
      // unwraps `data`); older shapes nested it under `data`, so accept both.
      image: {
        create: (a: unknown) => Promise<{ image_key?: string; data?: { image_key?: string } }>;
      };
      file: {
        create: (a: unknown) => Promise<{ file_key?: string; data?: { file_key?: string } }>;
      };
      message: { create: (a: unknown) => Promise<unknown> };
    };
  };
};

async function sendMessage(
  client: LarkMediaClient,
  receiveId: string,
  msgType: string,
  content: object,
  receiveIdType: "chat_id" | "open_id" = "chat_id",
): Promise<void> {
  await client.im.v1.message.create({
    params: { receive_id_type: receiveIdType },
    data: { receive_id: receiveId, msg_type: msgType, content: JSON.stringify(content) },
  });
}

export async function sendLarkAttachment(
  client: LarkMediaClient,
  chatId: string,
  filePath: string,
  kind: AttachmentKind,
  caption: string | undefined,
  openStream: (p: string) => unknown = createReadStream,
  receiveIdType: "chat_id" | "open_id" = "chat_id",
): Promise<void> {
  if (kind === "image") {
    const up = await client.im.v1.image.create({
      data: { image_type: "message", image: openStream(filePath) },
    });
    const imageKey = up.image_key ?? up.data?.image_key;
    if (!imageKey) throw new Error("lark image upload returned no image_key");
    await sendMessage(client, chatId, "image", { image_key: imageKey }, receiveIdType);
  } else {
    const up = await client.im.v1.file.create({
      data: { file_type: "stream", file_name: basename(filePath), file: openStream(filePath) },
    });
    const fileKey = up.file_key ?? up.data?.file_key;
    if (!fileKey) throw new Error("lark file upload returned no file_key");
    await sendMessage(client, chatId, "file", { file_key: fileKey }, receiveIdType);
  }
  if (caption) await sendMessage(client, chatId, "text", { text: caption }, receiveIdType);
}
