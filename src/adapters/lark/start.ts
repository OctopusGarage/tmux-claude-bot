import {
  createLarkChannel,
  Domain,
  type LarkChannel,
  type LarkChannelOptions,
  LoggerLevel,
} from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { logger } from "../../shared/utils/logger.js";
import { makeCardActionHandler } from "./card-actions.js";
import { makeMessageHandler } from "./handlers.js";
import { startKeepalive } from "./keepalive.js";
import { notifyLarkOwner } from "./resource.js";

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
 */
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
  };
}

/**
 * Start the Lark adapter on the SDK's higher-level Lark channel (WebSocket
 * long-connection, no public callback URL needed). No-op when `config.lark`
 * is undefined (LARK_ENABLED!=true or credentials missing), so the Telegram
 * path is unaffected. A connection failure here is logged and never crashes the
 * process — it must not take down the Telegram bot.
 */
export function startLark(deps: HandlerDeps, opts: { recoveredFromCrash?: boolean } = {}): void {
  const cfg = deps.config.lark;
  if (!cfg) {
    logger.info("[lark] disabled — skipping (run `npm run setup:lark` to onboard via QR scan)");
    return;
  }
  const domain = cfg.domain === "lark" ? Domain.Lark : Domain.Feishu;
  const channel: LarkChannel = createLarkChannel(larkChannelOptions(cfg, domain));
  channel.on("message", makeMessageHandler(channel, deps));
  channel.on("cardAction", makeCardActionHandler(channel, deps));
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
  channel
    .connect()
    .then(() => {
      logger.info(`[lark] connected (domain=${cfg.domain}, app=${cfg.appId})`);
      // Mirror Telegram: after a launchd auto-recovery, DM the owner that the bot
      // restarted from a crash. Best-effort. Disable with TCB_STARTUP_NOTIFY=0.
      if (opts.recoveredFromCrash && process.env.TCB_STARTUP_NOTIFY !== "0") {
        void notifyLarkOwner(
          cfg,
          messages("lark").crashRecovered(new Date().toLocaleString()),
        ).catch((err) =>
          logger.warn(
            `[lark] owner crash-alert failed: ${err instanceof Error ? err.message : err}`,
          ),
        );
      }
    })
    .catch((err) =>
      logger.error(`[lark] connect failed: ${err instanceof Error ? err.message : err}`),
    );
}
