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
 * Best-effort proactive DM to the first allow-listed owner — same owner
 * resolution as `notifyLarkOwner`, but sends an interactive card instead of
 * plain text. Used for the autopilot human-gate push.
 */
export async function notifyLarkOwnerCard(cfg: LarkConfig, card: object): Promise<void> {
  const owner = [...cfg.allowedOpenIds][0];
  if (owner === undefined) return;
  await clientFor(cfg).im.v1.message.create({
    params: { receive_id_type: "open_id" },
    data: { receive_id: owner, msg_type: "interactive", content: JSON.stringify(card) },
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

export interface CreatedChat {
  chatId: string;
  name: string;
}

/**
 * Create a private group with the bot as owner and the given user invited.
 * Requires the `im:chat` scope. Returns the new chat_id.
 */
export async function createBoundChat(
  cfg: LarkConfig,
  opts: { name: string; inviteOpenId: string; description?: string },
): Promise<CreatedChat> {
  const result = await clientFor(cfg).im.v1.chat.create({
    data: {
      name: opts.name,
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      chat_mode: "group",
      chat_type: "private",
      user_id_list: [opts.inviteOpenId],
    },
    params: { user_id_type: "open_id" },
  });
  const chatId = (result as { data?: { chat_id?: string } }).data?.chat_id;
  if (!chatId) {
    throw new Error(`chat.create returned no chat_id: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return { chatId, name: opts.name };
}
