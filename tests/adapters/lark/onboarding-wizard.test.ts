import { registerApp } from "@larksuiteoapi/node-sdk";
import qrcode from "qrcode-terminal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLarkOnboardingWizard } from "../../../src/adapters/lark/onboarding-wizard.js";
import { setupMessages } from "../../../src/core/i18n/setup.js";

vi.mock("@larksuiteoapi/node-sdk", () => ({
  registerApp: vi.fn(),
}));

vi.mock("qrcode-terminal", () => ({
  default: { generate: vi.fn() },
}));

const registerAppMock = vi.mocked(registerApp);
const qrGenerateMock = vi.mocked(qrcode.generate);

describe("runLarkOnboardingWizard", () => {
  beforeEach(() => {
    registerAppMock.mockReset();
    qrGenerateMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders QR guidance, handles SDK status events, and returns env values", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    registerAppMock.mockImplementation(async (options) => {
      options.onQRCodeReady?.({ url: "https://open.feishu.cn/qr", expireIn: 121 });
      options.onStatusChange?.({ status: "domain_switched" });
      options.onStatusChange?.({ status: "slow_down" });
      options.onStatusChange?.({ status: "polling" });
      return {
        client_id: "cli_123",
        client_secret: "secret_456",
        user_info: { open_id: "ou_abc", tenant_brand: "lark" },
      };
    });

    const msgs = setupMessages("en");
    const env = await runLarkOnboardingWizard(log, msgs);

    expect(registerAppMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "tmux-claude-bot",
        appPreset: { name: "tmux-claude-bot {user}" },
      }),
    );
    expect(qrGenerateMock).toHaveBeenCalledWith("https://open.feishu.cn/qr", { small: true });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Scan the QR code"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("valid for about 2 min"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("https://open.feishu.cn/qr"));
    expect(log.info).toHaveBeenCalledWith(msgs.domainSwitched);
    expect(log.warn).toHaveBeenCalledWith(msgs.slowDown);
    expect(env).toEqual({
      LARK_ENABLED: "true",
      LARK_APP_ID: "cli_123",
      LARK_APP_SECRET: "secret_456",
      LARK_DOMAIN: "lark",
      LARK_ALLOWED_OPEN_IDS: "ou_abc",
    });
  });
});
