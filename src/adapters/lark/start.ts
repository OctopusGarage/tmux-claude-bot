import {
  createLarkChannel,
  Domain,
  type LarkChannel,
  type LarkChannelOptions,
  LoggerLevel,
  type NormalizedMessage,
} from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { createLogger } from "../../shared/utils/logger.js";
import { makeCardActionHandler } from "./card-actions.js";
import { makeMessageHandler } from "./handlers.js";
import { startKeepalive } from "./keepalive.js";
import { registerLarkNotifications } from "./notifications.js";

const log = createLogger("lark.start");

export function logIncomingMessageBoundary(msg: NormalizedMessage): void {
  log.info(
    `message event received chat=${msg.chatId} chat_type=${msg.chatType} content_type=${msg.rawContentType} sender=${msg.senderId || "?"}`,
  );
}

/**
 * Options for the SDK's `createLarkChannel`. Extracted (and exported) so the
 * critical no-@ guarantee is regression-tested:
 *
 * `policy.requireMention: false` — receive ALL group messages, not just
 * @-mentions. The SDK's PolicyGate otherwise drops non-@ group messages
 * (requireMention defaults to true) BEFORE our handler runs, so a bound project
 * group could never work without @bot. Our own handler is the gate (it only acts
 * on bound project groups from the allow-listed owner), so the SDK-level mention
 * filter must be off. (Still requires the Feishu `im:message.group_msg` scope so
 * Feishu delivers the non-@ messages in the first place.)
 *
 * `safety.dedup.ttl` — the SDK's default is 12h, and the SAME dedup cache gates
 * card-action re-clicks (keyed on messageId+openId+value), so a user can't
 * re-press the same button on the same card for 12h. Message-redelivery dedup
 * only needs to outlast the SDK's 30-min stale-message window (older events are
 * dropped before dedup), so we cap the TTL to that window: message dedup stays
 * correct while button re-clicks free up after 30 min. Override with
 * LARK_DEDUP_TTL_MS (lowering it further trades message-redelivery safety for
 * snappier re-clicks).
 */
const DEFAULT_DEDUP_TTL_MS = 30 * 60_000; // matches the SDK's stale-message window

function dedupTtlMs(): number {
  const raw = Number(process.env.LARK_DEDUP_TTL_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_DEDUP_TTL_MS;
}

export function larkChannelOptions(
  cfg: { appId: string; appSecret: string },
  domain: Domain,
): LarkChannelOptions {
  return {
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain,
    source: "tmux-claude-bot",
    loggerLevel: LoggerLevel.info,
    policy: { requireMention: false },
    safety: { dedup: { ttl: dedupTtlMs() } },
  };
}

/**
 * Start the Lark adapter on the SDK's higher-level Lark channel (WebSocket
 * long-connection, no public callback URL needed). No-op when `config.lark`
 * is undefined (LARK_ENABLED!=true or credentials missing), so the Telegram
 * path is unaffected. A connection failure here is logged and never crashes the
 * process — it must not take down the Telegram bot.
 */
export function startLark(deps: HandlerDeps): void {
  const cfg = deps.config.lark;
  if (!cfg) {
    log.info("disabled — skipping (run `npm run setup:lark` to onboard via QR scan)");
    return;
  }
  const domain = cfg.domain === "lark" ? Domain.Lark : Domain.Feishu;
  const channel: LarkChannel = createLarkChannel(larkChannelOptions(cfg, domain));
  const messageHandler = makeMessageHandler(channel, deps);
  channel.on("message", async (msg) => {
    logIncomingMessageBoundary(msg);
    await messageHandler(msg);
  });
  channel.on("cardAction", makeCardActionHandler(channel, deps));

  // Chat prompts are intentionally not restored across bot restarts. Replaying a
  // recovered user message can duplicate input that was already typed into the
  // agent pane before the process stopped.
  // App-level WS watchdog — catches half-open sockets after laptop sleep /
  // network flaps that the SDK's own reconnect loop can miss. Ticks are
  // no-ops until connect() initializes the WS client.
  startKeepalive({
    getStatus: () => channel.getConnectionStatus(),
    probeUrl: cfg.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn",
    forceReconnect: async () => {
      await channel.disconnect();
      await channel.connect();
    },
  });
  registerLarkNotifications(deps, cfg, channel);

  channel
    .connect()
    .then(() => {
      log.info(`connected (domain=${cfg.domain}, app=${cfg.appId})`);
    })
    .catch((err) => log.error("connect failed", { err }));
}
