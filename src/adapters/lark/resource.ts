import { Client, Domain } from "@larksuiteoapi/node-sdk";
import type { AppConfig } from "../../shared/types.js";

type LarkConfig = NonNullable<AppConfig["lark"]>;

let cached: { appId: string; client: Client } | null = null;

function clientFor(cfg: LarkConfig): Client {
  if (cached?.appId === cfg.appId) return cached.client;
  const client = new Client({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: cfg.domain === "lark" ? Domain.Lark : Domain.Feishu,
  });
  cached = { appId: cfg.appId, client };
  return client;
}

/**
 * Best-effort proactive DM to the first allow-listed owner (open_id) — used for
 * the crash-restart alert. Uses the HTTP API (independent of the WS channel), so
 * it works as soon as the app credentials are valid. No-op without an owner.
 */
export async function notifyLarkOwner(cfg: LarkConfig, text: string): Promise<void> {
  const owner = [...cfg.allowedOpenIds][0];
  if (owner === undefined) return;
  await clientFor(cfg).im.v1.message.create({
    params: { receive_id_type: "open_id" },
    data: { receive_id: owner, msg_type: "text", content: JSON.stringify({ text }) },
  });
}

/**
 * Download a resource embedded in a Feishu message (voice/audio/video/file) to
 * `destPath`. Message media MUST go through `im.v1.messageResource.get` with the
 * MESSAGE_ID — the channel's `downloadResource` hits `im.v1.file.get`, which is
 * for standalone uploaded files and returns 400 on a message resource (this was
 * the "transcription failed" voice bug). `type` is "file" for audio/video/file, "image" for
 * images.
 */
export async function downloadMessageResource(
  cfg: LarkConfig,
  messageId: string,
  fileKey: string,
  destPath: string,
  type: "file" | "image" = "file",
): Promise<void> {
  const resp = (await clientFor(cfg).im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  })) as { writeFile: (p: string) => Promise<unknown> };
  await resp.writeFile(destPath);
}
