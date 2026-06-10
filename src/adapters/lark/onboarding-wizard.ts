import { registerApp } from "@larksuiteoapi/node-sdk";
import qrcode from "qrcode-terminal";
import type { SetupMessages } from "../../core/i18n/setup.js";
import { buildLarkEnvValues } from "./onboarding.js";

export interface WizardLog {
  info: (s: string) => void;
  warn: (s: string) => void;
}

/**
 * Run the Feishu/Lark QR onboarding: render a QR code in the terminal, wait for
 * the user to scan it and create a PersonalAgent app, and return the resulting
 * LARK_* env values (the caller persists them to `.env`). Shared by the unified
 * `npm run setup` (inline) and the standalone `npm run setup:lark`. `msgs` is
 * the setup catalog for the language the operator picked at the start.
 */
export async function runLarkOnboardingWizard(
  log: WizardLog,
  msgs: SetupMessages,
): Promise<Record<string, string>> {
  const result = await registerApp({
    source: "tmux-claude-bot",
    appPreset: { name: "tmux-claude-bot {user}" },
    onQRCodeReady: (info) => {
      console.log(`\n${msgs.qrScanPrompt}\n`);
      qrcode.generate(info.url, { small: true });
      const mins = Math.max(1, Math.round(info.expireIn / 60));
      console.log(`\n${msgs.qrExpiry(mins)}`);
      console.log(`${msgs.qrBrowserAlt(info.url)}\n`);
    },
    onStatusChange: (info) => {
      if (info.status === "domain_switched") {
        log.info(msgs.domainSwitched);
      } else if (info.status === "slow_down") {
        log.warn(msgs.slowDown);
      }
    },
  });
  return buildLarkEnvValues(result);
}
