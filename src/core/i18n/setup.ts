import { isUiLang, type Lang } from "./index.js";

/**
 * Messages for the interactive setup wizards (`npm run setup`, `npm run
 * setup:lark`). Kept separate from the chat-UI catalog (Messages) because the
 * audiences differ: this is operator-facing CLI guidance, picked once at the
 * start of the wizard via {@link parseSetupLang}. Every catalog implements the
 * full {@link SetupMessages} shape.
 */
export interface SetupMessages {
  // Shared / non-interactive
  envExampleNotFound: (path: string) => string;
  envExists: (path: string) => string;
  yesNeedsToken: string;
  wroteEnvNonInteractive: string;
  noTelegramTokenKeepLark: string;
  allowedIdsEmpty: string;
  // Wizard intro + chat-app choice
  configuring: string;
  whichChatApp: string;
  invalidChatChoice: string;
  // Telegram
  proxyPrompt: string;
  tokenPrompt: string;
  tokenBadShape: string;
  botOk: (username: string, masked: string) => string;
  tokenRejected: string;
  noTokenAfter3: string;
  dryRunSkipCapture: string;
  authorizeNow: string;
  waitingUpTo: (secs: number) => string;
  captureListenerFailed: (err: string) => string;
  botAlreadyRunningHint: string;
  noMessageReceived: string;
  enterIdsManually: string;
  captured: (who: string, id: string) => string;
  // Lark / Feishu
  dryRunSkipLark: string;
  larkIntro: string;
  larkConnected: (appId: string, domain: string) => string;
  larkAuthorizedUser: (ids: string) => string;
  larkNoOpenId: string;
  // Lark standalone wizard (setup:lark)
  larkWizardIntro: string;
  larkAppCreated: string;
  larkRestartHint: (cmd: string) => string;
  // Lark QR onboarding (onboarding-wizard)
  qrScanPrompt: string;
  qrExpiry: (mins: number) => string;
  qrBrowserAlt: (url: string) => string;
  domainSwitched: string;
  slowDown: string;
  // Remaining prompts
  allowedDirsPrompt: string;
  claudeStartPrompt: string;
  voiceIntro: string;
  voiceFoundBinary: string;
  voiceSkipHint: string;
  mlxPathPrompt: string;
  voiceLangPrompt: string;
  // Finish
  dryRunComplete: string;
  wroteEnv: (path: string) => string;
  telegramIds: (ids: string) => string;
  telegramIdsNone: string;
  larkConfiguredRestart: string;
}

const en: SetupMessages = {
  envExampleNotFound: (path) => `.env.example not found at ${path}`,
  envExists: (path) =>
    `${path} already exists. Re-run with --reconfigure (npm run setup:reconfigure) to edit it.`,
  yesNeedsToken:
    "--yes needs either a valid TELEGRAM_BOT_TOKEN or an existing LARK_* (Feishu) config.",
  wroteEnvNonInteractive: "Wrote .env (non-interactive).",
  noTelegramTokenKeepLark: "No TELEGRAM_BOT_TOKEN — keeping existing Feishu/Lark-only config.",
  allowedIdsEmpty:
    "TELEGRAM_ALLOWED_USER_IDS is empty — the bot will reject ALL messages until you set it (npm run setup:reconfigure).",
  configuring: "Configuring tmux-claude-bot. Press Enter to accept the [default].",
  whichChatApp: "Which chat app? 1) Telegram  2) Feishu/Lark  3) Both",
  invalidChatChoice: "Invalid choice — pick 1, 2, or 3.",
  proxyPrompt: "HTTP proxy for Telegram (optional)",
  tokenPrompt: "Telegram bot token (from @BotFather)",
  tokenBadShape: "That doesn't look like a token (digits:letters). Try again.",
  botOk: (username, masked) => `Bot: @${username}  (token ${masked})`,
  tokenRejected: "Telegram rejected that token. Check it and try again.",
  noTokenAfter3: "No valid token after 3 attempts. Aborting.",
  dryRunSkipCapture: "[dry-run] skipping live id capture; using 123456789.",
  authorizeNow: "Now authorize yourself: open Telegram and send your bot ANY message.",
  waitingUpTo: (secs) => `Waiting up to ${secs}s…`,
  captureListenerFailed: (err) => `Could not start capture listener (${err}).`,
  botAlreadyRunningHint:
    "If the bot is already running, stop it first (npm run service:uninstall) or enter your id manually.",
  noMessageReceived: "No message received.",
  enterIdsManually: "Enter your numeric Telegram id(s), comma-separated",
  captured: (who, id) => `Captured ${who}(${id})`,
  dryRunSkipLark: "[dry-run] skipping Feishu QR; using placeholder LARK_* values.",
  larkIntro: "Feishu/Lark: scan a QR code with the Feishu app to create the app.",
  larkConnected: (appId, domain) => `Feishu connected · App ID: ${appId} · Tenant: ${domain}`,
  larkAuthorizedUser: (ids) => `Authorized scanning user: ${ids}`,
  larkNoOpenId:
    "No open_id captured — LARK_ALLOWED_OPEN_IDS is empty (rejects everyone). Fill in your open_id in .env manually.",
  larkWizardIntro:
    "Feishu onboarding wizard: scan a QR code with the Feishu app to create the app; credentials will be written to .env",
  larkAppCreated: "App created, credentials written to .env",
  larkRestartHint: (cmd) => `Restart the bot to apply: ${cmd} (in dev, restart npm run dev)`,
  qrScanPrompt: "Scan the QR code below with the Feishu app to create the app:",
  qrExpiry: (mins) => `QR code is valid for about ${mins} min`,
  qrBrowserAlt: (url) => `Or open it directly in a browser: ${url}`,
  domainSwitched: "Detected an international tenant; switched to the larksuite.com domain.",
  slowDown: "Polling too fast; automatically slowed down.",
  allowedDirsPrompt: "Allowed project directories (comma-separated)",
  claudeStartPrompt: "Claude start command",
  voiceIntro: "Voice transcription (optional): turn voice messages into text. Apple Silicon only.",
  voiceFoundBinary:
    "Found an mlx_whisper binary — press Enter to use it, or blank it out to disable voice.",
  voiceSkipHint:
    "Press ENTER to skip for now. To enable later: `npm run whisper:install` auto-fills this. (No need to type a path by hand.)",
  mlxPathPrompt: "mlx_whisper binary path (Enter to skip)",
  voiceLangPrompt: "Voice recognition language (zh/en/auto)",
  dryRunComplete: "[dry-run] flow complete. Resolved config (NOT written, secrets masked):",
  wroteEnv: (path) => `Wrote ${path}`,
  telegramIds: (ids) => `Telegram ids: ${ids}`,
  telegramIdsNone: "(none — Telegram will reject everyone!)",
  larkConfiguredRestart: "Feishu/Lark configured. Restart the bot to connect.",
};

const zh: SetupMessages = {
  envExampleNotFound: (path) => `未找到 .env.example：${path}`,
  envExists: (path) =>
    `${path} 已存在。重新运行并加 --reconfigure（npm run setup:reconfigure）来修改。`,
  yesNeedsToken: "--yes 需要一个有效的 TELEGRAM_BOT_TOKEN，或已有的 LARK_*（飞书）配置。",
  wroteEnvNonInteractive: "已写入 .env（非交互模式）。",
  noTelegramTokenKeepLark: "没有 TELEGRAM_BOT_TOKEN —— 保留已有的飞书/Lark 配置。",
  allowedIdsEmpty:
    "TELEGRAM_ALLOWED_USER_IDS 为空 —— 在你设置它之前，bot 会拒绝所有消息（npm run setup:reconfigure）。",
  configuring: "正在配置 tmux-claude-bot。按回车采用 [默认值]。",
  whichChatApp: "使用哪个聊天应用？1) Telegram  2) 飞书/Lark  3) 两者都要",
  invalidChatChoice: "无效选择 —— 请输入 1、2 或 3。",
  proxyPrompt: "Telegram 的 HTTP 代理（可选）",
  tokenPrompt: "Telegram bot token（来自 @BotFather）",
  tokenBadShape: "这看起来不像 token（数字:字母）。请重试。",
  botOk: (username, masked) => `Bot：@${username}  （token ${masked}）`,
  tokenRejected: "Telegram 拒绝了该 token。请检查后重试。",
  noTokenAfter3: "3 次尝试后仍无有效 token。已中止。",
  dryRunSkipCapture: "[dry-run] 跳过实时 id 捕获；使用 123456789。",
  authorizeNow: "现在授权你自己：打开 Telegram，给你的 bot 发送任意一条消息。",
  waitingUpTo: (secs) => `最多等待 ${secs} 秒…`,
  captureListenerFailed: (err) => `无法启动捕获监听器（${err}）。`,
  botAlreadyRunningHint:
    "如果 bot 已在运行，请先停止它（npm run service:uninstall），或手动输入你的 id。",
  noMessageReceived: "未收到消息。",
  enterIdsManually: "请输入你的数字 Telegram id（多个用逗号分隔）",
  captured: (who, id) => `已捕获 ${who}(${id})`,
  dryRunSkipLark: "[dry-run] 跳过飞书二维码；使用占位的 LARK_* 值。",
  larkIntro: "飞书/Lark：用飞书 App 扫码创建应用。",
  larkConnected: (appId, domain) => `飞书已接入 · App ID：${appId} · Tenant：${domain}`,
  larkAuthorizedUser: (ids) => `已授权扫码用户：${ids}`,
  larkNoOpenId:
    "未拿到扫码用户的 open_id —— LARK_ALLOWED_OPEN_IDS 为空（会拒绝所有人）。请手动把你的 open_id 填入 .env。",
  larkWizardIntro: "飞书接入向导：用飞书 App 扫码创建应用，凭证将写入 .env",
  larkAppCreated: "应用创建成功，凭证已写入 .env",
  larkRestartHint: (cmd) => `重启 bot 生效：${cmd}（开发态则重启 npm run dev）`,
  qrScanPrompt: "请用飞书 App 扫描以下二维码完成应用创建：",
  qrExpiry: (mins) => `二维码有效期约 ${mins} 分钟`,
  qrBrowserAlt: (url) => `也可以直接在浏览器打开：${url}`,
  domainSwitched: "识别到国际版租户，已切换到 larksuite.com 域名。",
  slowDown: "轮询速度过快，已自动降速。",
  allowedDirsPrompt: "允许的项目目录（多个用逗号分隔）",
  claudeStartPrompt: "Claude 启动命令",
  voiceIntro: "语音转写（可选）：把语音消息转成文字。仅支持 Apple Silicon。",
  voiceFoundBinary: "找到了 mlx_whisper 可执行文件 —— 按回车使用它，或清空以禁用语音。",
  voiceSkipHint:
    "按回车先跳过。稍后启用：运行 `npm run whisper:install` 会自动填好此项。（无需手动输入路径。）",
  mlxPathPrompt: "mlx_whisper 可执行文件路径（回车跳过）",
  voiceLangPrompt: "语音识别语言（zh/en/auto）",
  dryRunComplete: "[dry-run] 流程完成。解析后的配置（未写入，密钥已遮蔽）：",
  wroteEnv: (path) => `已写入 ${path}`,
  telegramIds: (ids) => `Telegram id：${ids}`,
  telegramIdsNone: "（无 —— Telegram 会拒绝所有人！）",
  larkConfiguredRestart: "飞书/Lark 已配置。重启 bot 以连接。",
};

const yue: SetupMessages = {
  envExampleNotFound: (path) => `搵唔到 .env.example：${path}`,
  envExists: (path) =>
    `${path} 已經存在。重新執行並加 --reconfigure（npm run setup:reconfigure）嚟修改。`,
  yesNeedsToken: "--yes 需要一個有效嘅 TELEGRAM_BOT_TOKEN，或者已有嘅 LARK_*（飛書）設定。",
  wroteEnvNonInteractive: "已寫入 .env（非互動模式）。",
  noTelegramTokenKeepLark: "冇 TELEGRAM_BOT_TOKEN —— 保留已有嘅飛書/Lark 設定。",
  allowedIdsEmpty:
    "TELEGRAM_ALLOWED_USER_IDS 係空 —— 喺你設定佢之前，bot 會拒絕所有訊息（npm run setup:reconfigure）。",
  configuring: "正在設定 tmux-claude-bot。撳 Enter 採用 [預設值]。",
  whichChatApp: "用邊個聊天應用？1) Telegram  2) 飛書/Lark  3) 兩個都要",
  invalidChatChoice: "無效選擇 —— 請輸入 1、2 或 3。",
  proxyPrompt: "Telegram 嘅 HTTP 代理（可選）",
  tokenPrompt: "Telegram bot token（嚟自 @BotFather）",
  tokenBadShape: "呢個睇落唔似 token（數字:字母）。請重試。",
  botOk: (username, masked) => `Bot：@${username}  （token ${masked}）`,
  tokenRejected: "Telegram 拒絕咗呢個 token。請檢查之後再試。",
  noTokenAfter3: "試咗 3 次都冇有效 token。已中止。",
  dryRunSkipCapture: "[dry-run] 略過即時 id 擷取；使用 123456789。",
  authorizeNow: "而家授權你自己：打開 Telegram，俾你嘅 bot 發送任何一條訊息。",
  waitingUpTo: (secs) => `最多等 ${secs} 秒…`,
  captureListenerFailed: (err) => `無法啟動擷取監聽器（${err}）。`,
  botAlreadyRunningHint:
    "如果 bot 已經喺度運行，請先停止佢（npm run service:uninstall），或者手動輸入你嘅 id。",
  noMessageReceived: "未收到訊息。",
  enterIdsManually: "請輸入你嘅數字 Telegram id（多個用逗號分隔）",
  captured: (who, id) => `已擷取 ${who}(${id})`,
  dryRunSkipLark: "[dry-run] 略過飛書二維碼；使用佔位嘅 LARK_* 值。",
  larkIntro: "飛書/Lark：用飛書 App 掃碼建立應用。",
  larkConnected: (appId, domain) => `飛書已接入 · App ID：${appId} · Tenant：${domain}`,
  larkAuthorizedUser: (ids) => `已授權掃碼用戶：${ids}`,
  larkNoOpenId:
    "未攞到掃碼用戶嘅 open_id —— LARK_ALLOWED_OPEN_IDS 係空（會拒絕所有人）。請手動將你嘅 open_id 填入 .env。",
  larkWizardIntro: "飛書接入向導：用飛書 App 掃碼建立應用，憑證將寫入 .env",
  larkAppCreated: "應用建立成功，憑證已寫入 .env",
  larkRestartHint: (cmd) => `重啟 bot 生效：${cmd}（開發態則重啟 npm run dev）`,
  qrScanPrompt: "請用飛書 App 掃描以下二維碼完成應用建立：",
  qrExpiry: (mins) => `二維碼有效期約 ${mins} 分鐘`,
  qrBrowserAlt: (url) => `亦可以直接喺瀏覽器打開：${url}`,
  domainSwitched: "偵測到國際版租戶，已切換到 larksuite.com 域名。",
  slowDown: "輪詢速度太快，已自動降速。",
  allowedDirsPrompt: "允許嘅項目目錄（多個用逗號分隔）",
  claudeStartPrompt: "Claude 啟動命令",
  voiceIntro: "語音轉寫（可選）：將語音訊息轉成文字。僅支援 Apple Silicon。",
  voiceFoundBinary: "搵到 mlx_whisper 執行檔 —— 撳 Enter 用佢，或者清空嚟停用語音。",
  voiceSkipHint:
    "撳 Enter 暫時略過。之後啟用：執行 `npm run whisper:install` 會自動填好呢項。（唔使手動輸入路徑。）",
  mlxPathPrompt: "mlx_whisper 執行檔路徑（Enter 略過）",
  voiceLangPrompt: "語音識別語言（zh/en/auto）",
  dryRunComplete: "[dry-run] 流程完成。解析後嘅設定（未寫入，密鑰已遮蔽）：",
  wroteEnv: (path) => `已寫入 ${path}`,
  telegramIds: (ids) => `Telegram id：${ids}`,
  telegramIdsNone: "（無 —— Telegram 會拒絕所有人！）",
  larkConfiguredRestart: "飛書/Lark 已設定。重啟 bot 嚟連接。",
};

const SETUP_CATALOGS: Record<Lang, SetupMessages> = { en, zh, yue };

/** The setup-wizard message catalog for a language. */
export function setupMessages(lang: Lang): SetupMessages {
  return SETUP_CATALOGS[lang];
}

/** Neutral prompt for the upfront language picker (shown before a language is chosen). */
export const SETUP_LANG_PROMPT = "Language / 语言 / 語言?  1) English  2) 中文  3) 粤語";

/** Parse the language picker answer (number or code); null if unrecognized. */
export function parseSetupLang(input: string): Lang | null {
  const v = input.trim().toLowerCase();
  if (v === "1" || v === "en" || v === "english") return "en";
  if (v === "2" || v === "zh" || v === "中文") return "zh";
  if (v === "3" || v === "yue" || v === "粤语" || v === "粵語") return "yue";
  return isUiLang(v) ? v : null;
}
