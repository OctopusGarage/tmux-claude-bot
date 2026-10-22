import { createLogger } from "../../shared/utils/logger.js";
import { messages } from "../i18n/index.js";
import type { RemotePrincipal } from "./remote-access.js";

type Channel = RemotePrincipal["channel"];
type DenialReason = "identity" | "authorization" | "approval";
type Sender = { recipients: string[]; send: (recipient: string, text: string) => Promise<unknown> };
const WINDOW_MS = 10 * 60_000;
const THRESHOLD = 5;
const log = createLogger("security.alerts");

/** Passive installation-wide warnings; network delivery never blocks authorization. */
export class SecurityAlerts {
  private attempts: number[] = [];
  private nextAlertAt = 0;
  private readonly senders = new Map<Channel, Sender>();
  private readonly now: () => number;
  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Adapters supply only configured allowlisted private recipients, never group targets. */
  register(channel: Channel, recipients: Iterable<string>, send: Sender["send"]): void {
    const privateRecipients = [...new Set(recipients)].filter((id) =>
      channel === "telegram" ? /^[1-9]\d{0,19}$/.test(id) : /^ou_[A-Za-z0-9_-]+$/.test(id),
    );
    this.senders.set(channel, { recipients: privateRecipients, send });
  }

  record(channel: Channel, reason: DenialReason): void {
    const now = this.now();
    if (now < this.nextAlertAt) return;
    this.attempts = this.attempts.filter((timestamp) => timestamp > now - WINDOW_MS);
    this.attempts.push(now);
    if (this.attempts.length < THRESHOLD) return;
    // Reserve cooldown before starting asynchronous sends; the counter stays bounded.
    this.attempts = [];
    this.nextAlertAt = now + WINDOW_MS;
    log.warn("Repeated remote access denials", { data: { channel, reason } });
    for (const [targetChannel, sender] of this.senders) {
      const m = messages(targetChannel);
      const text = m.securityAlert(channel, m.securityAlertReason(reason));
      for (const recipient of sender.recipients) {
        void Promise.resolve()
          .then(() => sender.send(recipient, text))
          .catch(() => {
            // Provider exceptions may contain tokens or request payloads.
            log.warn("Could not deliver a security alert to a configured recipient");
          });
      }
    }
  }
}
