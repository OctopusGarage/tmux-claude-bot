import { statSync } from "node:fs";
import { normalizeError } from "../../shared/utils/error.js";
import { type AttachmentKind, validateAttachment } from "../attachments/classify.js";

export type NotificationChannel = "telegram" | "lark";
export type NotificationChannelSelection = NotificationChannel | "both";
export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface NotificationRequest {
  channel?: NotificationChannelSelection;
  level?: NotificationLevel;
  title: string;
  body?: string;
  source?: string;
  session?: string;
  attachments?: NotificationAttachment[];
}

export interface NotificationAttachment {
  path: string;
  caption?: string;
}

export interface NotificationDelivery {
  channel: NotificationChannel;
  ok: boolean;
  error?: string;
}

export interface NotificationResult {
  status: "sent" | "partial" | "failed";
  deliveries: NotificationDelivery[];
}

export type NotificationSendFn = (message: string, request?: NotificationRequest) => Promise<void>;
export type NotificationAttachmentSendFn = (
  path: string,
  kind: AttachmentKind,
  caption?: string,
) => Promise<void>;

export type NotificationOptions = {
  statInfo?: (p: string) => { size: number; isFile: boolean } | null;
};

const CHANNELS: NotificationChannel[] = ["telegram", "lark"];

const LEVEL_PREFIX: Record<NotificationLevel, string> = {
  info: "ℹ️",
  success: "✅",
  warning: "⚠️",
  error: "❌",
};

export class NotificationGateway {
  private readonly senders = new Map<NotificationChannel, NotificationSendFn>();
  private readonly attachmentSenders = new Map<NotificationChannel, NotificationAttachmentSendFn>();

  register(channel: NotificationChannel, fn: NotificationSendFn): void {
    this.senders.set(channel, fn);
  }

  registeredChannels(): NotificationChannel[] {
    return CHANNELS.filter((channel) => this.senders.has(channel));
  }

  registerAttachment(channel: NotificationChannel, fn: NotificationAttachmentSendFn): void {
    this.attachmentSenders.set(channel, fn);
  }

  async notify(
    req: NotificationRequest,
    opts: NotificationOptions = {},
  ): Promise<NotificationResult> {
    const channels = this.resolveChannels(req.channel);
    const message = formatNotification(req);
    const attachments = req.attachments?.filter((a) => a.path.trim()) ?? [];
    let anyOperationSucceeded = false;
    const deliveries = await Promise.all(
      channels.map(async (channel): Promise<NotificationDelivery> => {
        const sender = this.senders.get(channel);
        if (!sender) return { channel, ok: false, error: "no sender registered" };
        try {
          await sender(message, req);
          anyOperationSucceeded = true;
          const attachmentSender = this.attachmentSenders.get(channel);
          if (attachments.length > 0 && !attachmentSender) {
            return { channel, ok: false, error: "no attachment sender registered" };
          }
          for (const attachment of attachments) {
            const validation = validateAttachment(
              attachment.path,
              opts.statInfo ?? defaultStatInfo,
            );
            if (!validation.ok) return { channel, ok: false, error: validation.error };
            await attachmentSender?.(attachment.path, validation.kind, attachment.caption);
          }
          return { channel, ok: true };
        } catch (err) {
          return { channel, ok: false, error: normalizeError(err).message };
        }
      }),
    );
    const ok = deliveries.filter((d) => d.ok).length;
    return {
      status:
        ok === deliveries.length ? "sent" : ok > 0 || anyOperationSucceeded ? "partial" : "failed",
      deliveries,
    };
  }

  private resolveChannels(
    selection: NotificationChannelSelection | undefined,
  ): NotificationChannel[] {
    if (selection === "telegram" || selection === "lark") return [selection];
    if (selection === "both") return CHANNELS;
    const configured = CHANNELS.filter((channel) => this.senders.has(channel));
    return configured.length > 0 ? configured : ["telegram"];
  }
}

function defaultStatInfo(p: string): { size: number; isFile: boolean } | null {
  try {
    const st = statSync(p);
    return { size: st.size, isFile: st.isFile() };
  } catch {
    return null;
  }
}

export function formatNotification(req: NotificationRequest): string {
  const level = req.level ?? "info";
  const title = req.title.trim();
  const lines = [`${LEVEL_PREFIX[level]} ${title}`];
  if (req.source?.trim()) lines.push(`source: ${req.source.trim()}`);
  const head = lines.join("\n");
  const body = req.body?.trimEnd();
  return body ? `${head}\n\n${body}` : head;
}
