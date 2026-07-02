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
  chatId: string,
  msgType: string,
  content: object,
): Promise<void> {
  await client.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) },
  });
}

export async function sendLarkAttachment(
  client: LarkMediaClient,
  chatId: string,
  filePath: string,
  kind: AttachmentKind,
  caption: string | undefined,
  openStream: (p: string) => unknown = createReadStream,
): Promise<void> {
  if (kind === "image") {
    const up = await client.im.v1.image.create({
      data: { image_type: "message", image: openStream(filePath) },
    });
    const imageKey = up.image_key ?? up.data?.image_key;
    if (!imageKey) throw new Error("lark image upload returned no image_key");
    await sendMessage(client, chatId, "image", { image_key: imageKey });
  } else {
    const up = await client.im.v1.file.create({
      data: { file_type: "stream", file_name: basename(filePath), file: openStream(filePath) },
    });
    const fileKey = up.file_key ?? up.data?.file_key;
    if (!fileKey) throw new Error("lark file upload returned no file_key");
    await sendMessage(client, chatId, "file", { file_key: fileKey });
  }
  if (caption) await sendMessage(client, chatId, "text", { text: caption });
}
