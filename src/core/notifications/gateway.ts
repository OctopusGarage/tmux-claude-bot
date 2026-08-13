import { statSync } from "node:fs";
import { normalizeError } from "../../shared/utils/error.js";
import { tildeifyHome } from "../../shared/utils/path.js";
import { type AttachmentKind, validateAttachment } from "../attachments/classify.js";
import { NotificationPolicyStore } from "./policy-store.js";

export type NotificationChannel = "telegram" | "lark";
export type NotificationChannelSelection = NotificationChannel | "both";
export type NotificationLevel = "info" | "success" | "warning" | "error";

export const NOTIFICATION_SOURCE_CATALOG = [
  "autopilot-delegate",
  "daily-audit",
  "daily-task-audit",
  "long-task-monitor",
  "loop-engineering",
  "opportunity-discovery",
  "resource-guardian",
  "runtime-guardian",
  "tmux-claude-bot",
] as const;

export type NotificationSource = (typeof NOTIFICATION_SOURCE_CATALOG)[number];

export interface NotificationRequest {
  channel?: NotificationChannelSelection;
  level?: NotificationLevel;
  title: string;
  body?: string;
  source?: NotificationSource | (string & {});
  session?: string;
  attachments?: NotificationAttachment[];
  opportunities?: NotificationOpportunity[];
  delivery?: NotificationDeliveryPolicy;
}

export type NotificationDeliveryPolicy =
  | {
      mode: "state-change";
      topic: string;
      state: string;
      notifyInitial?: boolean;
    }
  | {
      mode: "once-per-window";
      topic: string;
      window: string;
      state?: string;
    };

export interface NotificationOpportunity {
  id: string;
  title: string;
  projectName: string;
  category: string;
  confidence: string;
  estimatedComplexity: string;
  status: string;
  value: string;
  problem?: string;
  recommendedApproach?: string;
}

export interface NotificationAttachment {
  path: string;
  caption?: string;
}

export interface NotificationDelivery {
  channel: NotificationChannel;
  ok: boolean;
  error?: string;
  messageSent?: boolean;
  suppressed?: boolean;
  failedStage?:
    | "sender-missing"
    | "message"
    | "attachment-sender-missing"
    | "attachment-validation"
    | "attachment";
}

export interface NotificationResult {
  status: "sent" | "partial" | "failed" | "suppressed";
  deliveries: NotificationDelivery[];
}

type InternalNotificationDelivery = NotificationDelivery & { messageSent: boolean };

export type NotificationSendFn = (message: string, request?: NotificationRequest) => Promise<void>;
export type NotificationAttachmentSendFn = (
  path: string,
  kind: AttachmentKind,
  caption?: string,
  request?: NotificationRequest,
) => Promise<void>;

export type NotificationOptions = {
  statInfo?: (p: string) => { size: number; isFile: boolean } | null;
};

export type NotificationGatewayOptions = {
  stateDir?: string;
  now?: () => number;
  policyStore?: NotificationPolicyStore;
};

const CHANNELS: NotificationChannel[] = ["telegram", "lark"];
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_SAFE_MESSAGE_LIMIT = 3900;
const TELEGRAM_TRUNCATION_NOTICE =
  "\n\n[truncated for Telegram; see the linked report/logs for full details]";

const LEVEL_PREFIX: Record<NotificationLevel, string> = {
  info: "ℹ️",
  success: "✅",
  warning: "⚠️",
  error: "❌",
};

export class NotificationGateway {
  private readonly senders = new Map<NotificationChannel, NotificationSendFn>();
  private readonly attachmentSenders = new Map<NotificationChannel, NotificationAttachmentSendFn>();
  private readonly policyStore: NotificationPolicyStore;

  constructor(options: NotificationGatewayOptions = {}) {
    this.policyStore =
      options.policyStore ??
      new NotificationPolicyStore({
        ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
  }

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
    const deliveries = await Promise.all(
      channels.map(async (channel): Promise<InternalNotificationDelivery> => {
        if (!this.shouldDeliver(req, channel)) {
          return { channel, ok: true, messageSent: false, suppressed: true };
        }
        const sender = this.senders.get(channel);
        if (!sender)
          return {
            channel,
            ok: false,
            error: "no sender registered",
            messageSent: false,
            failedStage: "sender-missing",
          };
        let messageSent = false;
        try {
          await sender(messageForChannel(channel, message), req);
          messageSent = true;
          const attachmentSender = this.attachmentSenders.get(channel);
          if (attachments.length > 0 && !attachmentSender) {
            return {
              channel,
              ok: false,
              error: "no attachment sender registered",
              messageSent,
              failedStage: "attachment-sender-missing",
            };
          }
          for (const attachment of attachments) {
            const validation = validateAttachment(
              attachment.path,
              opts.statInfo ?? defaultStatInfo,
            );
            if (!validation.ok) {
              return {
                channel,
                ok: false,
                error: validation.error,
                messageSent,
                failedStage: "attachment-validation",
              };
            }
            try {
              await attachmentSender?.(attachment.path, validation.kind, attachment.caption, req);
            } catch (err) {
              return {
                channel,
                ok: false,
                error: normalizeError(err).message,
                messageSent,
                failedStage: "attachment",
              };
            }
          }
          this.recordDelivered(req, channel);
          return { channel, ok: true, messageSent };
        } catch (err) {
          return {
            channel,
            ok: false,
            error: normalizeError(err).message,
            messageSent,
            failedStage: messageSent ? "attachment" : "message",
          };
        }
      }),
    );
    const attempted = deliveries.filter((delivery) => !delivery.suppressed);
    const ok = attempted.filter((delivery) => delivery.ok).length;
    const publicDeliveries = deliveries.map((delivery): NotificationDelivery => {
      if (delivery.suppressed) return { channel: delivery.channel, ok: true, suppressed: true };
      if (delivery.ok) return { channel: delivery.channel, ok: true };
      return delivery;
    });
    if (attempted.length === 0) return { status: "suppressed", deliveries: publicDeliveries };
    if (ok === attempted.length) return { status: "sent", deliveries: publicDeliveries };
    if (ok > 0) return { status: "partial", deliveries: publicDeliveries };
    if (attempted.some((delivery) => delivery.messageSent)) {
      return { status: "partial", deliveries: publicDeliveries };
    }
    return { status: "failed", deliveries: publicDeliveries };
  }

  private shouldDeliver(req: NotificationRequest, channel: NotificationChannel): boolean {
    const delivery = req.delivery;
    if (delivery === undefined) return true;
    const fingerprint =
      delivery.mode === "state-change"
        ? delivery.state
        : `${delivery.window}:${delivery.state ?? "occurrence"}`;
    return this.policyStore.shouldDeliver(
      delivery.topic,
      fingerprint,
      channel,
      delivery.mode === "once-per-window" || (delivery.notifyInitial ?? true),
    );
  }

  private recordDelivered(req: NotificationRequest, channel: NotificationChannel): void {
    const delivery = req.delivery;
    if (delivery === undefined) return;
    const fingerprint =
      delivery.mode === "state-change"
        ? delivery.state
        : `${delivery.window}:${delivery.state ?? "occurrence"}`;
    this.policyStore.recordDelivered(delivery.topic, fingerprint, channel);
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
  const head = `${LEVEL_PREFIX[level]} ${title}`;
  const body = req.body?.trimEnd();
  return tildeifyHome(body ? `${head}\n${body}` : head);
}

function messageForChannel(channel: NotificationChannel, message: string): string {
  if (channel !== "telegram" || message.length <= TELEGRAM_MESSAGE_LIMIT) return message;
  const maxBody = Math.max(0, TELEGRAM_SAFE_MESSAGE_LIMIT - TELEGRAM_TRUNCATION_NOTICE.length);
  return `${message.slice(0, maxBody).trimEnd()}${TELEGRAM_TRUNCATION_NOTICE}`;
}
