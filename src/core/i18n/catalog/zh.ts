import { UI_ICONS } from "../../../shared/ui/icons.js";

/**
 * Canonical message catalog (Chinese). This file DEFINES the message shape —
 * `Messages = typeof zh` — so every other language must implement exactly these
 * keys (a missing key fails the build). Entries are either static strings or
 * functions for interpolation. Keep keys protocol-agnostic; both adapters use
 * them. New chat/card/button/notification copy goes here first, then every
 * catalog listed by `UI_LANGS`. `tests/core/i18n.test.ts` verifies catalog key
 * parity and non-empty renders.
 */
export const zh = {
  // ── acks / queue (executor) ──
  ackReceived: "已接收",
  queuedAt: (pos: number) => `已排队 · 第 ${pos} 位`,
  queueFull: (max: number) => `队列已满（上限 ${max}），请稍后再试`,
  noCurrentProject: "无当前会话，请先用 /list_alive_projects 选择或 /add_project 新建",
  errorPrefix: (msg: string) => `错误：${msg}`,
  projectTag: (project: string) => `📂 ${project}`,

  // ── voice ──
  voiceLangTitle: "🎙️ 语音识别语言",
  voiceLangCardPrompt: (lang: string) => `当前(飞书)：**${lang}** · 点按钮切换`,
  autoDetect: "自动检测",
  voiceHeard: (text: string) => `🎙️ 你说的是：「${text}」`,
  voiceHeardTranslated: (original: string, translated: string) =>
    `🎙️ 你说的是：「${original}」\n🌐 发送英文：「${translated}」`,
  promptTranslateTitle: `${UI_ICONS.feature.translate} 翻译模式`,
  promptTranslateCardPrompt: (mode: string) => `当前：**${mode}** · 点按钮切换`,
  voiceTranscribeFailed: "转写失败 · 请重试或改发文字",
  voiceTranslateFailed: "翻译失败 · 请重试或改发文字",
  promptTranslateFailed: "翻译失败 · 请重试或关闭 prompt 翻译",
  promptTranslatedSent: (from: string, to: string) => `已翻译并发送 ${from}->${to}`,
  promptTranslateAlreadyInstalled: "🌐 prompt 翻译依赖已就绪",
  promptTranslateInstalling: "🌐 正在安装 prompt 翻译依赖 · 首次需下载模型，请稍候…",
  promptTranslateInstallOk: "🌐 prompt 翻译依赖已就绪 · 现在可以开启翻译模式",
  promptTranslateInstallFailed: (e: string) =>
    `🌐 安装失败 · ${e} · 可在主机运行 npm run translate:install 查看详情`,
  promptTranslateCommandUsage: (usage: string) => `用法：/prompt_translate ${usage}`,
  promptTranslateUnavailable: (error: string) => `Prompt translation 不可用：${error}`,
  promptTranslateDisabledFor: (source: string) => `已关闭 ${source} 的 prompt translation`,
  promptTranslateStatusOff: (source: string) => `${source} 的 prompt translation：off`,
  promptTranslateStatusLine: (source: string, from: string, to: string) =>
    `${source} 的 prompt translation：argos ${from}->${to}`,
  promptTranslateEnabledLine: (line: string) => `已开启。${line}`,
  voiceEmpty: "没听清 · 请再说一遍或改发文字",
  voiceUnsupported: "语音转写仅支持 Apple Silicon",
  voiceNotInstalled: "语音转写未安装（在仓库运行 npm run whisper:install）",

  // ── project switch / remove / current ──
  currentProjectIs: (project: string) => `${UI_ICONS.session.current} 当前会话：${project}`,
  projectStatusSession: (alive: boolean) =>
    `${alive ? UI_ICONS.session.active : UI_ICONS.session.stopped} 会话：${alive ? "运行中" : "未运行"}`,
  projectStatusAgent: (agent: string | null, running: boolean, busy: boolean) =>
    agent
      ? `${running ? (busy ? UI_ICONS.session.busy : UI_ICONS.agent.generic) : UI_ICONS.session.stopped} Agent：${agent}${running ? (busy ? " 忙碌" : " 空闲") : " 未运行"}`
      : `${UI_ICONS.agent.none} Agent：无`,
  projectStatusType: (isFree: boolean) =>
    `${isFree ? UI_ICONS.session.independent : UI_ICONS.session.regular} 类型：${isFree ? "独立会话" : "常规会话"}`,
  projectStatusGroup: (label: string | null) =>
    `${label ? UI_ICONS.group.projectGroup : UI_ICONS.group.none} 群：${label ?? "无"}`,
  projectStatusLine: (session: string, agent: string, type: string, group: string) =>
    `${session} · ${agent} · ${type} · ${group}`,
  switched: "已切换",
  switchedTo: (project: string) => `已切换：${project}`,
  removed: "已移除",
  nestingWarning:
    "⚠️ 这是 tmux-claude-bot 自己的代码库——用 bot 驱动它通常会嵌套(只回「已接收」无结果)。建议切到别的真实项目。",

  // ── UI-language picker (/lang) ──
  uiLangTitle: "🌐 界面语言",
  uiLangCurrent: (lang: string) => `当前界面语言：${lang} · 点按钮切换`,
  uiLangSet: (lang: string) => `界面语言已设为 ${lang}`,

  // ── help card ──
  helpTitle: "使用帮助",
  helpRunning: "**⚡ 运行中**",
  helpProjects: "**📂 项目 / 视图**",

  // ── buttons (control keyboard / help card / project lists) ──
  btnEnter: "⏎ 回车",
  btnEsc: "⎋ Esc",
  btnInterrupt: `${UI_ICONS.action.interrupt} 中断`,
  btnRestart: "🔄 重启",
  btnClear: `${UI_ICONS.action.clear} clear`,
  btnCompact: `${UI_ICONS.action.compact} compact`,
  btnUp: "⬆️ up",
  btnDown: "⬇️ down",
  btnLeft: "⬅️ left",
  btnRight: "➡️ right",
  btnTab: "⇥ Tab",
  btnStatus: "📊 状态",
  btnStart: "🚀 启动",
  btnResume: "🔄 恢复会话",
  btnExit: `${UI_ICONS.action.exit} 退出`,
  btnPeek: "👁 peek",
  btnHistory: "📜 历史",
  btnInputs: "🔁 重发",
  btnQueue: `${UI_ICONS.tone.queue} 队列`,
  btnDashboard: "📊 仪表盘",
  btnProjects: "🟢 活跃会话",
  btnRecent: "🕘 近期",
  btnCurrent: "📌 当前会话",
  btnAddProject: "➕ 新建项目",
  btnSwitch: "🔀 切换",
  btnRemove: "🗑 删除",
  btnCreate: "➕ 创建",
  btnHelp: "💡 帮助",
  btnVoiceLang: "🎙️ 语音语言",
  btnVoiceInstall: "🎙️ 安装语音",
  btnPromptTranslate: `${UI_ICONS.feature.translate} 翻译模式`,
  btnPromptTranslateOff: "⏻ 关闭",
  btnPromptTranslateInstall: `${UI_ICONS.feature.translate} 安装翻译`,
  btnUiLang: "🌐 界面语言",
  btnActiveMarker: "✅ 当前",
  btnMore: "⌨️ 更多控制 ▾",
  btnCollapse: "▴ 收起",
  btnCancel: "✕ 取消",
  btnConfirmAction: (action: string) => `确认 ${action}`,
  btnDeleteMode: "🗑 删除…",
  confirmActionBody: (action: string, impact: string, target: string) =>
    `确认执行：${action}\n\n目标：${target}\n影响：${impact}\n\n请确认后继续。`,
  confirmImpactExit: "退出当前 Agent，并清空该会话等待中的队列。",
  confirmImpactRestart: "中断并重启当前 Agent，当前未保存的输入可能丢失。",
  confirmImpactClear: "发送 /clear，清空当前 Agent 上下文。",
  confirmImpactCompact: "发送 /compact，压缩当前 Agent 上下文。",

  // ── adopt (take over an unmanaged agent) ──
  adoptTitle: "🧲 可接管的未纳管进程",
  adoptEmpty: "没有发现可接管的进程",
  adoptConfirmPrompt: (label: string) =>
    `确认接管？将先中断并结束原进程，再在纳管会话中续接：\n${label}`,
  btnAdoptConfirm: "🧲 接管",
  btnAdoptAsFree: `${UI_ICONS.session.independent} 接管为独立会话`,
  btnAdoptCancel: "✕ 取消",
  adoptCancelled: "已取消接管",
  adoptWorking: "正在接管…",
  recoverEmpty: "没有需要恢复的项目。",
  cmdInputs: "取回最近的输入以编辑",
  inputsTitle: "📝 最近输入(点一个取回编辑)",
  inputsEmpty: "没有可重发的输入",
  inputsExpired: "列表已过期,请重新发送 /inputs",
  inputDraftToast: "✏️ 已取回为草稿,编辑后发送",
  recoverAllRunning: (count: number, list: string) =>
    `🟢 ${count} 个项目都在运行中，暂无需要恢复的：\n\n${list}`,
  btnRecover: "🔄 恢复",
  recoverPreview: (count: number, alive: number, list: string) =>
    `🔄 将恢复 ${count} 个项目${alive > 0 ? `（${alive} 个运行中，跳过）` : ""}\n\n${list}\n\n确认恢复？`,
  btnRecoverConfirm: "🔄 确认恢复",
  recoverWorking: "正在恢复…",
  recoverCancelled: "已取消恢复。",
  recoverBusy: "已有一个恢复正在进行,请稍候。",
  recoverDone: (launched: number, shellOnly: number, alive: number, failed: number) =>
    `🔄 恢复完成\n\n🔁 重启 ${launched}${shellOnly > 0 ? ` · 🐚 重建 ${shellOnly}` : ""} · 🟢 运行中 ${alive}${failed > 0 ? ` · ⚠️ 失败 ${failed}` : ""}`,
  adoptGone: "该进程已不在可接管列表（已退出或已被纳管）",
  adoptDone: (proj: string, resumed: boolean) =>
    resumed ? `✅ 已接管并续接会话：${proj}` : `✅ 已接管并新建会话：${proj}`,
  adoptFailed: "接管失败：进程无法结束或未能启动",
  adoptAgentDidNotStart:
    "接管失败：原进程已结束，但 Agent 未能在纳管会话中启动。请用 /peek 查看画面，修正 shell 提示或启动命令后重试。",
  adoptBusy:
    "目标会话里已有程序在前台运行（另一个 agent 或其他程序）。已中止，未动原进程——请先去那边退出，再重新接管。",
  adoptProjectRunning:
    "已有相同项目正在运行 Claude/Codex。已中止，未动原进程——如需并行接管，请选择「接管为独立会话」。",
  btnAdoptAttach: "💻 在电脑终端查看（可选）",
  adoptAttachHint: (cmd: string) => `✅ 如需查看会话，可在电脑终端执行这个可选命令：\n命令：${cmd}`,

  // ── command results (dispatch) ──
  doneShort: "完成",
  agentNotRunningRestart: "未运行，请使用 /resume 恢复，或 /start 新建",
  contentTruncated: "...(内容过长，已截断)",
  agentEmptyOutput: "返回空内容 · 用 /peek 查看画面",
  agentReplyUnavailable: "未捕获到有效 Agent 回复 · 用 /peek 查看画面，确认后可重试。",
  agentStarted: "✅ 已启动",
  agentResumed: "🔄 已恢复原会话",
  agentResumeMissingState: "没有可恢复的原会话状态，请用 /start 新建。",
  agentAlreadyRunning: "✅ 已在运行中，无需重复启动",
  agentInputNotReady: "Agent 暂时还没准备好接收输入，请稍后重试；如果持续出现，请重启该会话。",
  projectAutomationBusy: (taskKind: string, projectId: string, runId: string, supervisor: string) =>
    `项目正在执行自动化任务，暂时不能发送普通消息。\n任务：${taskKind}\n项目：${projectId}\nRun：${runId}\nSupervisor：${supervisor}\n\n请等待任务完成，或先查看/取消该任务后再继续。`,
  agentStartedWith: (label: string) => `✅ 已用「${label}」启动`,
  startPickerTitle: "🚀 选择启动方式",
  startPickerPrompt: "配置了多个启动命令,选一个启动:",
  btnStartThis: "🚀 用这个启动",
  agentExited: "✅ 已退出",
  agentRestarted: "🔄 已重启",
  sentEsc: "✅ 已发送 Esc",
  interrupted: "✅ 已中断 · Ctrl-C",
  clearedContext: "✅ 已清空上下文 · /clear",
  compactedContext: "✅ 已压缩上下文 · /compact",
  sentEnter: "✅ 已回车",
  sentUp: "✅ 已发送 ↑",
  sentDown: "✅ 已发送 ↓",
  sentLeft: "✅ 已发送 ←",
  sentRight: "✅ 已发送 →",
  sentTab: "✅ 已发送 Tab",
  statusRunning: (agent: string) => `🟢 ${agent} 运行中`,
  statusNotRunning: (agent: string) => `🔴 ${agent} 未运行`,
  statusContext: (bar: string, pct: number) => `📊 上下文 ${bar} ${pct}%`,
  statusFiveHour: (bar: string, pct: number, reset: string) =>
    `⏱ Session(5h) ${bar} ${pct}%（重置 ${reset}）`,
  statusSevenDay: (bar: string, pct: number, reset: string) =>
    `📅 本周 ${bar} ${pct}%（重置 ${reset}）`,
  statusUsageStale: (mins: number) => `⚠️ 额度数据 ${mins} 分钟未更新（agent 可能已关闭）`,

  // ── queue-status view ──
  // -- status usage install --
  statusUsageHint:
    "\u{1F4A1} \u60f3\u770b\u989d\u5ea6\uff1f\u53d1\u9001 /status_install \u4e00\u952e\u5b89\u88c5",
  statusUsagePending:
    "\ud83d\udcca \u989d\u5ea6\u6570\u636e\u83b7\u53d6\u4e2d\u2014\u2014\u4e0b\u6b21 Claude \u8c03\u7528\u540e\u663e\u793a",
  statusUsageNoData:
    "\ud83d\udcca \u672c\u4f1a\u8bdd\u6682\u65e0\u7528\u91cf\u6570\u636e \u00b7 \u53d1\u6761\u6d88\u606f\u540e\u4f1a\u5237\u65b0",
  statusModeApi: "API",
  statusModeSubscription: "订阅",
  statusApiLine: (mode: string, host: string) => `🔌 ${mode} · ${host}`,
  statusInstallTitle: "\u{1F4CA} \u989d\u5ea6\u4e0a\u62a5\u5b89\u88c5",
  statusInstallNoClaude:
    "\u672a\u68c0\u6d4b\u5230\u8fd0\u884c\u4e2d\u7684 Claude\u3002\u7528\u91cf\u4e0a\u62a5\u5b89\u88c5\u4ec5\u9002\u7528\u4e8e Claude\uff1bCodex \u5df2\u5728\u4f1a\u8bdd\u8bb0\u5f55\u4e2d\u539f\u751f\u4e0a\u62a5\u7528\u91cf\uff0c\u65e0\u9700\u5b89\u88c5\u3002",
  statusInstallInstalled: (dir: string) =>
    `\u2705 ${dir} \u5df2\u5b89\u88c5\u989d\u5ea6\u4e0a\u62a5`,
  statusInstallAlready: (dir: string) => `\u23ED ${dir} \u5df2\u5b89\u88c5\u8fc7`,
  statusInstallForeignPrompt: (dirs: string[]) =>
    `⚠️ 以下目录已有自定义 statusLine，如何处理？推荐「包裹保留」（保留你的 statusLine 并附加额度上报）。\n${dirs.join("\n")}`,
  statusInstallOverwritten: (dir: string, backup: string) =>
    `\u{1F501} ${dir} \u5df2\u8986\u76d6\uff08\u5907\u4efd\uff1a${backup}\uff09`,
  statusInstallWrapped: (dir: string, backup: string) =>
    `\u{1F4E6} ${dir} \u5df2\u5305\u88f9\uff1a\u4fdd\u7559\u4f60\u539f\u6709\u663e\u793a + \u989d\u5ea6\u4e0a\u62a5\n   \u26A0\uFE0F statusLine \u73b0\u7ecf\u672c bot \u5305\u88f9\u5c42\uff1b\u82e5\u72b6\u6001\u680f\u5f02\u5e38\uff0c\u4ece\u5907\u4efd\u8fd8\u539f\uff1a${backup}`,
  statusInstallSnippet: (dir: string, snippet: string) =>
    `\u270D\uFE0F ${dir}\uff1a\u628a\u4e0b\u9762\u8fd9\u6bb5\u52a0\u5230\u4f60\u7684 statusline \u811a\u672c\uff08\u9700\u811a\u672c\u91cc\u5df2\u6709 input=$(cat)\uff09\uff1a\n\`\`\`\n${snippet}\n\`\`\``,
  statusInstallSkipped: (dir: string) => `\u2716\uFE0F ${dir} \u5df2\u8df3\u8fc7`,
  statusInstallError: (dir: string, msg: string) => `\u274C ${dir}\uff1a${msg}`,
  btnStatusInstall: "\u{1F4CA} \u5b89\u88c5\u989d\u5ea6\u4e0a\u62a5",
  btnStatusOverwrite: "\u{1F501} \u8986\u76d6\u66ff\u6362",
  btnStatusWrap: "📦 包裹保留（推荐）",
  btnStatusSnippet: "\u270D\uFE0F \u7ed9\u6211\u7247\u6bb5",
  btnStatusSkip: "\u2716\uFE0F \u653e\u5f03",
  queueGlobalHeader: "━━ 🌐 全局队列 ━━",
  queueCounts: (queued: number, processing: boolean) =>
    `排队中： ${queued} | 处理中： ${processing ? "🟢" : "🔴"}`,
  queueSessionHeader: "━━ 会话队列 ━━",
  queueNoSessions: "没有活跃的会话队列",
  queueLastDone: (s: number) => `上次完成： ${s}s 前`,
  queueItemCancelled: "已取消该排队消息",
  queueItemRewritten: "已改写该排队消息",
  queueItemGone: `该消息已不在队列（可能正在执行，可用 ${UI_ICONS.action.interrupt} 中断停止）`,
  queueTitle: "队列状态",

  // ── history / peek / placeholders ──
  paneTitle: "👁 会话画面",
  emptyPane: "（空）",
  historyTitle: "📜 历史记录",
  historyTitleShort: "历史记录",
  noPathMapping: "缺少项目路径映射 · 先用 /add_project 建立",
  noHistory: "没有找到对话历史",
  onlyNRounds: (n: number) => `只有 ${n} 条对话记录`,
  emptyOutput: "(无输出)",

  // ── project lists ──
  noCurrentProjectShort: "无当前会话",
  aliveListTitle: (n: number) => `活跃会话 (${n})`,
  aliveListEmpty: "没有活跃会话，用 /add_project <路径> 新建",
  recentListTitle: "近期项目",
  recentListTitleN: (n: number) => `近期项目 (${n})`,
  recentListEmpty: "没有近期项目，用 /add_project <路径> 添加",

  // ── project ops / add_project ──
  notADir: (p: string) => `${p} 不是目录`,
  dirNotExist: (p: string) => `目录不存在：${p}`,
  pathNotAllowedPath: (p: string) => `路径不在允许范围内：${p}`,
  alreadySwitched: "已存在 · 已切换",
  projectCreated: "项目已创建",
  projectCreatedPath: (p: string) => `项目已创建：${p}`,
  projectPathCollision: (p: string) =>
    `⚠️ 此目录的会话名与已有项目（${p}）冲突，重命名其一后才能同时使用。`,
  browseTitle: "📂 选择项目位置",
  browseRootsTitle: "📂 选择起始目录",
  browseEmpty: "（无子目录）",
  browseUnreadable: "⚠️ 无法读取该目录",
  browseCancelled: "已取消",
  btnBrowseUp: "⬆️ 上级",
  btnBrowseCreate: "✅ 在此创建项目",
  btnBrowseCancel: "✖️ 取消",
  btnBrowseNewFolder: "➕ 新建文件夹",
  browseNewFolderPrompt: (p: string) => `请回复要在 ${p} 内新建的文件夹名称`,
  browseNewFolderInvalid: "❌ 名称无效（不能为空或包含「/」）",
  browseNewFolderExists: "❌ 该名称已存在",
  browseNewFolderError: "❌ 新建文件夹失败",
  shortIdNotFound: (id: string) => `未找到短 id：${id}`,
  noCurrentProjectSet: "未设置当前会话\n\n用 /add_project <路径> 设置一个",
  currentProjectTitle: "当前会话",
  noRecentProjects: "没有近期项目\n\n用 /add_project <路径> 添加一个",
  messageTooLong: (len: number, max: number) => `消息过长 · ${len} > ${max} 字符`,
  onlyTextVoice: "暂仅支持文本和语音消息",
  handlerErrorTelegram: "⚠️ 处理消息时出错，请重试。",
  handlerError: "⚠️ 处理消息时出错，请重试；若群组无响应，可发送 /restore 重新连接项目。",
  unknownCommand: (name: string) => `未知命令：/${name}（发送 /help 查看命令）`,

  // ── transient toasts (Telegram callback answers) ──
  toastProcessing: "➕ 处理中…",
  sessionGone: "会话不存在或已结束",
  toastSwitched: "✅ 已切换",
  toastRemoving: "🗑 移除中…",
  toastSent: (action: string) => `已发送 /${action}`,
  toastError: "出错了",

  // ── progress / result labels ──
  processingQueued: (pos: number) => `处理中 · 队列第 ${pos} 位`,
  processing: "处理中",
  duplicateIgnored: "重复消息，已忽略（上一条相同内容仍在处理）",
  failed: "失败",
  taskStillRunning: (body: string) => `⏳ 任务仍在进行中，请稍后通过 /peek 查看当前结果\n\n${body}`,
  taskStillRunningNotice: "⏳ 任务仍在进行中，完成后会自动推送结果 · /peek 查看当前画面",
  voiceDownloadFailed: "语音下载失败 · 网络波动,请重试",
  historyYou: "🧑‍💻 你",
  crashRecovered: (time: string) =>
    `♻️ tmux-claude-bot 异常重启 — 上次未正常退出（崩溃/被杀），已自动恢复 · ${time}`,

  // ── Telegram MSG (shared reply strings) ──
  noSession: "没有活跃会话 · 先 /list_alive_projects 或 /add_project",
  notRunning: "未运行 · /start 启动，或 /restart 继续",
  noShortId: (id: string) => `未找到短 ID：${id}`,
  pathNotAllowed: (dirs: string[]) => `路径不在允许列表 · 允许：${dirs.join("、")}`,
  voiceNotEnabled:
    "🎙️ 语音功能未启用 · 发送 /voice_install 一键安装（仅 Apple Silicon），或在主机运行 npm run whisper:install",
  voiceNeedsAppleSilicon: "🎙️ 语音转写需要 Apple Silicon（macOS arm64）· 当前主机不支持，请改发文字",
  voiceAlreadyInstalled: "🎙️ 语音功能已就绪 · 直接发语音即可",
  voiceInstalling: "🎙️ 正在安装语音功能 · 首次需下载依赖（约 1-2 分钟），稍候…",
  voiceInstallOk: "🎙️ 语音功能已就绪 · 现在可以直接发语音了",
  voiceInstallFailed: (e: string) =>
    `🎙️ 安装失败 · ${e} · 可在主机运行 npm run whisper:install 查看详情`,
  voiceLangCurrent: (lang: string) =>
    `🎙️ 当前识别语言：${lang === "auto" ? "自动检测" : lang} · 点下方按钮切换`,
  voiceLangSet: (lang: string) =>
    `🎙️ 识别语言已设为 ${lang === "auto" ? "自动检测" : lang} · 下条语音生效`,
  voiceLangInvalid: "🎙️ 用法：/voice_lang <en|zh|yue|ja|es|auto 或 2-3 位语言代码>",

  // ── help intro (command-free preamble; command list is generated from command-catalog.ts) ──
  helpIntroTelegram: `🤖 tmux-claude-bot

发任意文字 → 转给 agent → 返回结果
🎙️ 语音转写为可选功能 · /voice_install 启用（仅 Apple Silicon）· /voice_lang 设识别语言

提示：消息会收到 👀（已接收）/👍（完成）回应；处理中就地显示进度并编辑成结果；结果下方有 ⏎/${UI_ICONS.action.interrupt}/⎋/🔄 快捷按钮。`,

  helpIntroLark: `🤖 tmux-claude (Lark)

发任意文字 → 转给 agent → 返回结果`,

  // ── help section headers ──
  helpSectionProjects: "📂 项目",
  helpSectionSession: "▶️ 会话",
  helpSectionGroups: "👥 群组",
  helpSectionSettings: "⚙️ 设置",
  helpSectionDiagnostics: "🛠 诊断",
  helpSectionRunning: "⚡ 运行中",
  helpSectionIdle: "🚀 未运行",

  // ── command descriptions (used by command-catalog.ts to build help text) ──
  cmdCurrentProject: "当前会话",
  cmdListAlive: "活跃会话（点按切换/删除）",
  cmdListRecent: "近期项目",
  cmdAddProject: "新建项目",
  cmdNewFree: "新建独立会话（同工作区可并行）",
  freeProjectLimit: (max: number) => `独立会话已达上限 ${max} 个，请先删除一个再试。`,
  freeProjectCreated: (slot: number, label: string | null) =>
    `${UI_ICONS.session.independent} 已创建独立会话 #${slot}${label ? `（${label}）` : ""}\n可 /cd 到任意目录并自行启动 agent；/list_alive_projects 可切回。`,
  btnNewFree: `${UI_ICONS.session.independent} 新建独立会话`,
  freeLabelPrompt: "请输入独立会话名称（发送 - 跳过命名）",
  freeLabelCancelled: "已取消",
  cmdAdopt: "接管未纳管 agent",
  cmdQueueStatus: "队列状态",
  cmdHistory: "对话历史（默认最近一条）",
  cmdPeek: "查看会话画面",
  cmdVoiceLang: "语音识别语言（英/中/粤/日/西/自动）",
  cmdPromptTranslate: "prompt 翻译（status/off/on 源语言 目标语言）",
  cmdTranslateInstall: "安装 prompt 翻译依赖",
  cmdLang: "界面语言（英/简/繁/粤/日/西）",
  cmdEnter: "回车",
  cmdEsc: "Escape",
  cmdInterrupt: "Ctrl-C",
  cmdRestart: "重启 (--continue)",
  cmdClear: "清空上下文",
  cmdCompact: "压缩上下文",
  cmdArrowsTab: "方向键 / Tab",
  cmdExit: "退出",
  cmdStatus: "检查状态",
  cmdStart: "启动 agent",
  cmdResume: "恢复上一次原 agent 会话",
  cmdDoctor: "运行安装健康检查",
  cmdRecover: "重启后恢复所有项目",
  cmdStatusInstall: "为 /status 安装用量上报",
  cmdVoiceInstall: "安装语音转写(Apple Silicon)",
  cmdHelp: "本帮助",
  cmdWs: "工作区管理（save/use/list/remove）",

  // ── workspaces ──
  wsSaved: (name: string, session: string) => `✅ 已保存工作区「${name}」→ ${session}`,
  wsUsed: (name: string) => `✅ 已切换到工作区「${name}」`,
  wsRemoved: (name: string) => `✅ 已删除工作区「${name}」`,
  wsNotFound: (name: string) => `工作区「${name}」不存在`,
  wsSessionGone: (name: string) => `工作区「${name}」对应的会话已不存在`,
  wsNoCurrentProject: "无当前会话，请先用 /add_project 新建项目",
  wsListEmpty: "暂无保存的工作区",
  wsListTitle: "📎 工作区",
  wsListItem: (name: string, session: string) => `• **${name}** → ${session}`,
  wsInvalidName: "工作区名称仅允许字母、数字、连字符和下划线（1-32 位）",
  wsUsage: "用法：/ws <save <name> | use <name> | list | remove <name>>",

  // ── sessions ──
  noSessions: "暂无保存的会话记录",
  sessionsTitle: (n: number) => `${n} 个会话记录，点击恢复`,
  sessionsLabel: (id: string, ago: string) => `${id} · ${ago}`,
  resumeStarted: (id: string) => `✅ 已恢复会话 ${id}`,
  cmdSessions: "浏览并恢复历史会话",

  // ── logs ──
  cmdLogs: "查看近期警告/错误日志（/logs <traceId|N>）",
  logsTitle: "🪵 近期日志",

  // ── prompt library ──
  cmdPrompts: "浏览收藏的提示词",
  promptsDisabled: "提示词库未启用（需在 .env 配置 PROMPT_MCP_COMMAND）",
  promptsEmpty: "没有匹配的提示词",
  promptsError: "提示词库连接失败，请稍后重试",
  promptsGone: "该提示词已不存在，请重新搜索",
  promptsTitle: (n: number) => `🔖 提示词库 (${n})`,
  promptsOpen: "查看/复制",
  promptsSearchTitle: (q: string, n: number) => `🔖 「${q}」匹配 ${n} 条`,
  promptsRefine: (shown: number, total: number) =>
    `共 ${total} 条，仅显示前 ${shown} 条 — 用 /prompts <关键词> 缩小`,
  promptsAll: "✖ 全部",
  promptsPrev: "◀ 上一页",
  promptsNext: "下一页 ▶",

  // ── dashboard ──
  cmdHome: "切换到主控操作员会话（未选项目时的默认目标）",
  homeOperatorDisabled: "未启用主控操作员会话",
  homeOperatorSwitched: "🏠 已切换到主控操作员会话",
  cmdDashboard: "查看全局仪表盘（所有会话状态总览）",
  cmdAutopilot: "把当前会话工作托管给 Loop Supervisor 推进",
  cmdOpportunity: "查看并讨论主动机会建议",
  cmdSysload: "查看本机负载、发热、跑飞进程和资源守护状态",
  sysloadTitle: "🖥 系统负载",
  dashboardTitle: "📊 仪表盘",
  dashboardOverallHealth: "总体健康",
  dashboardAttention: "待处理",
  dashboardActiveWork: "进行中的工作",
  dashboardAutomation: "自动化",
  dashboardOperatorAi: "Operator 与 AI 接口",
  dashboardRuntimeDomains: "运行域",
  dashboardRecentOutcomes: "最近结果",
  dashboardProjectSessions: "项目会话",
  dashboardNone: "无",
  dashboardMore: "更多",
  dashboardEnabled: "已启用",
  dashboardIdle: "空闲",
  dashboardShown: "已显示",
  dashboardHealthy: "健康",
  dashboardSession: "会话",
  dashboardSkills: "技能",
  dashboardMcpProfiles: "MCP 配置",
  dashboardPromptLibrary: "提示词库",
  dashboardSessions: "会话",
  dashboardRunning: "运行中",
  dashboardBusy: "忙碌",
  dashboardQueue: "队列",
  dashboardUp: "运行",
  dashboardNoAdapters: "无适配器",
  dashboardRuntimeDomain: (id: string) =>
    ({
      "work-orders": "工作单",
      "repository-reviews": "仓库 PR 审查",
      automation: "自动化",
      "daily-task-audit": "每日任务审计",
      "runtime-guardian": "运行时守护",
      "resource-guardian": "资源守护",
      "agent-capacity": "智能体容量",
      power: "服务与电源",
      "operator-ai": "操作员与 AI 接口",
    })[id] ?? id,
  dashboardHealthHealthy: "健康",
  dashboardHealthAttention: "需处理",
  dashboardHealthDegraded: "降级",
  dashboardAttentionOperatorSession: "Home Operator 会话需要处理",
  dashboardAttentionOperatorSkills: (installed: number, expected: number) =>
    `Home Operator 技能已就绪 ${installed}/${expected}`,
  dashboardAttentionOperatorMcp: (installed: number, expected: number) =>
    `受管 MCP 配置已就绪 ${installed}/${expected}`,
  dashboardAttentionOperatorPrompt: "已配置的提示词库当前不可用",
  dashboardAttentionWorkOrderFailed: (project: string, _taskKind: string) =>
    `${project} 的工作单失败`,
  dashboardAttentionWorkOrderAbandoned: (project: string) => `${project} 的 WorkOrder 已失去接管`,
  dashboardAttentionWorkOrderStale: (project: string) => `${project} 的 WorkOrder 派发已过期`,
  dashboardAttentionAutomationDependency: (automation: string) => `${automation} 存在未启用的依赖`,
  dashboardAttentionDailyAudit: (count: number) => `${count} 项 Daily Task Audit 需要处理`,
  dashboardAttentionRuntimeFinding: (project: string, _findingKind: string) =>
    `${project} 存在运行时守护发现`,
  dashboardAttentionResourcePressure: (_pressure: string, _circuit: string) => "资源守护需要处理",
  dashboardAttentionAgentCapacity: (agent: string, state: string) => `${agent} 容量状态为 ${state}`,
  dashboardAttentionPowerPolicy: (_mode: string, _phase: string, _schedule: string) =>
    "电源策略需要处理",
  dashboardAttentionRepositoryReview: (project: string, status: string, retryEpoch: number) =>
    status === "retry-wait"
      ? `${project} 正在自动重试（轮次 ${retryEpoch}）`
      : status === "manual-review"
        ? `${project} 存在已验证的人工边界`
        : `${project} 的仓库 PR 审查重试额度已耗尽`,
  autopilotTitle: `${UI_ICONS.feature.autopilot} Autopilot`,
  autopilotDelegatePanelBody:
    "把当前会话上下文托管给 Loop Supervisor。范围已经清楚时可以直接托管；需要先看清任务清单、验收标准和停止条件时，先看计划再确认推进。",
  autopilotUsage: (raw: string) =>
    `未知子命令「${raw}」。用法：/autopilot [需求] 或 /autopilot delegate [需求]`,
  autopilotPlanPreviewBody:
    "托管前计划预览\n\n目标：基于当前会话和仓库状态，继续推进用户已确认的任务，直到真正完成。\n\n任务清单：检查现场上下文、git 状态、近期提交、现有 PR 和之前的验证结果；判断还剩什么；只做必要改动；复核 diff；运行相关本地验证、触达风险路径的覆盖率复核，以及有必要时使用已有 eval。\n\n验收标准：最终 summary 记录检查了什么、改了什么、验证了什么、PR/合并结果、最终分支、干净 worktree，以及任何真实 blocker 和证据。\n\n停止条件：任务已完成、确认存在真实 blocker、或继续推进会越过当前范围时停止；避免为了优化而优化。\n\n非目标：不扩大范围，不重做已经满足要求的工作，不为了 bot 策略去安装目标项目依赖，不在项目策略未允许时合并。\n\n确认这份计划符合你的意图后，再继续托管推进。",
  langUsage: "用法 / Usage: /lang <en|zh|zh-TW|yue|ja|es>",
  sessionsRestoreHint: "用 `/sessions <id前缀>` 恢复",
  opportunityProjectFallback: "项目",
  opportunityProjectCount: (n: number) => `${n} 个项目`,
  opportunityDigestDelegable: (project: string, n: number) =>
    `${project} · ${n} 个建议\n可以继续讨论；确认要执行时，请使用 Autopilot 托管。`,
  opportunityDigestDiscussFirst: (project: string, n: number) =>
    `${project} · ${n} 个建议\n先参与讨论，确认清楚后再托管执行。`,
  btnOpportunityContinueDiscuss: "继续讨论",
  btnOpportunityDiscussAll: "讨论全部",
  btnOpportunityShow: "查看详情",
  btnOpportunityDiscuss: "参与讨论",
  btnOpportunityDismiss: "暂不处理",
  opportunityNotFound: (ids: string) => `Opportunity not found: ${ids}`,
  opportunitySkipped: (n: number) => `已跳过 ${n} 个建议。`,
  opportunitySkippedMissing: (n: number, ids: string) => `已跳过 ${n} 个建议。缺失：${ids}`,
  opportunityMixedProjects: "不能一起讨论来自不同项目的建议。",
  opportunityCannotOpenProject: (reason: string) => `无法打开项目进行讨论：${reason}`,
  opportunityDiscussionStarted: (n: number) => `正在讨论 ${n} 个建议。`,
  opportunityAutomationConflict: (taskKind: string, runId: string, supervisorSession: string) =>
    `项目正在执行自动化任务，暂时不能参与讨论。请等当前任务完成后再试。\n\n任务：${taskKind}\nRun：${runId}\nSupervisor：${supervisorSession}`,
  opportunityQueueBusy:
    "项目 agent 当前正在处理任务或已有排队消息，暂时不能参与讨论。请等当前任务完成后再试。",
  opportunityGitStatusUnknown: (reason: string) =>
    `无法确认项目 git 状态，暂时不能参与讨论。\n${reason}`,
  opportunityDirtyWorktree: (preview: string) =>
    `项目工作区不干净，暂时不能参与讨论。请先处理现有改动后再试。\n\n${preview}`,
  btnApDelegate: "🚀 继续托管推进",
  btnApDelegateNow: "🚀 直接托管",
  btnApReviewPlan: "📋 先看计划",
  btnApConfirmDelegate: "✅ 确认托管",
  btnApCancelDelegate: "⛔ 取消托管",
  btnApQueue: `${UI_ICONS.tone.queue} 查看队列`,
  btnApBack: "↩︎ 返回",
  autopilotQueueTitle: `${UI_ICONS.tone.queue} Supervisor 队列`,
  noLogsContext: "无当前会话，请先选择项目或指定 trace（/logs <traceId>）。",

  // ── group binding (Feishu) ──
  groupBoundWelcome: (label: string, path: string) =>
    `🎉 群组已绑定到 **${label}**\n\`${path}\`\n\n直接发消息即可，无需 @ 机器人。`,
  groupCreateFailed: (msg: string) =>
    `❌ 创建群组失败：${msg}\n\n请确保机器人已获得 \`im:chat\` 权限。`,
  groupBindOnlyInGroup: "在私聊中请使用 `/newgroup`，`/bind` 仅在群组内有效。",
  groupUnbindOnlyInGroup: "在私聊中无法解绑，`/unbind` 仅在群组内有效。",
  groupNewGroupOnlyInP2p: "`/newgroup` 仅在与机器人的私聊中有效。",
  groupRestored: (label: string) => `🔄 已恢复此群组 → **${label}**。`,
  groupMissingPath: (label: string) =>
    `⚠️ **${label}** 的工作区路径已不存在。请用 \`/rebind <路径|名称>\` 重新绑定。`,
  groupUnbound: "🔓 此群组已解除与工作区的绑定。",
  groupNotBound: "此群组尚未绑定工作区。请使用 `/bind <路径|名称>`。",
  groupTargetUsage: "用法：`<命令> <绝对路径 | ~/路径 | 工作区名称>`",
  btnGroupMenu: "🗂 项目群",
  btnMakeGroup: "🆕 建群",
  btnBindHere: "🔗 绑定",
  btnRebindGroup: "🔁 改绑",
  btnUnbindGroup: "🔓 解绑",
  btnRestoreGroup: "🔄 还原",
  groupPickerTitle: "🆕 新建项目群 — 选一个项目",
  groupBindPickerTitle: "🔗 绑定本群 — 选一个项目",
  groupBoundCardTitle: (label: string) => `🗂 本群已绑定：${label}`,
  groupMenuNoProjects: "暂无近期项目。先在私聊用 `/add_project <路径>` 添加一个。",
  groupNoNewGroupProjects: "暂无可新建项目群的常规项目（已有群或独立会话会隐藏）。",
  groupNoBindableProjects: "暂无可绑定的常规项目。先在私聊用 `/add_project <路径>` 添加一个。",
  groupNoParallelProjects: "暂无可新建并行项目群的常规项目。先添加一个常规项目。",
  groupCreatedShort: (label: string) => `✓ 已新建项目群「${label}」，去新群里继续。`,
  groupAlreadyExists: (label: string) =>
    `⚠️ 项目「${label}」已经有绑定群了，去那个群里用即可，无需重复创建。`,
  groupPinnedNoSwitch: (label: string) =>
    `🔒 本群已固定绑定「${label}」，不能切换到其他项目。如需更换，请用 🗂 → 改绑。`,
  groupNoRemoveInGroup: "🔒 在群里不能删除项目（会影响他人）。请到与机器人的私聊里删除。",
  groupFreePickerTitle: `${UI_ICONS.session.independent} 新建并行项目群（新建独立会话）`,
  groupOverviewTitle: "🗂 项目群",
  groupOverviewExisting: "已有项目群：",
  groupOverviewNoGroups: "暂无项目群。",
  groupOverviewItem: (label: string, path: string) => `• **${label}** — \`${path}\``,
  btnFreeGroup: `${UI_ICONS.session.independent} 新建并行群`,
  freeGroupCreated: (label: string) => `${UI_ICONS.session.independent} 已创建并行群「${label}」`,
};

// No `as const`: Messages widens to string / function types so other languages
// can provide their own copy while the KEY SET stays enforced.
export type Messages = typeof zh;
