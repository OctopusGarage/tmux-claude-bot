import { registerApp } from "@larksuiteoapi/node-sdk";
import qrcode from "qrcode-terminal";
import { buildLarkEnvValues } from "./onboarding.js";

export interface WizardLog {
  info: (s: string) => void;
  warn: (s: string) => void;
}

/**
 * Run the Feishu/Lark QR onboarding: render a QR code in the terminal, wait for
 * the user to scan it and create a PersonalAgent app, and return the resulting
 * LARK_* env values (the caller persists them to `.env`). Shared by the unified
 * `npm run setup` (inline) and the standalone `npm run setup:lark`.
 */
export async function runLarkOnboardingWizard(log: WizardLog): Promise<Record<string, string>> {
  const result = await registerApp({
    source: "tmux-claude-bot",
    appPreset: { name: "tmux-claude-bot {user}" },
    onQRCodeReady: (info) => {
      console.log("\n请用飞书 App 扫描以下二维码完成应用创建：\n");
      qrcode.generate(info.url, { small: true });
      const mins = Math.max(1, Math.round(info.expireIn / 60));
      console.log(`\n二维码有效期约 ${mins} 分钟`);
      console.log(`也可以直接在浏览器打开：${info.url}\n`);
    },
    onStatusChange: (info) => {
      if (info.status === "domain_switched") {
        log.info("识别到国际版租户，已切换到 larksuite.com 域名。");
      } else if (info.status === "slow_down") {
        log.warn("轮询速度过快，已自动降速。");
      }
    },
  });
  return buildLarkEnvValues(result);
}
