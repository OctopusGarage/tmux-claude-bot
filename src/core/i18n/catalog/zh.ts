/**
 * Canonical message catalog (Chinese). This file DEFINES the message shape —
 * `Messages = typeof zh` — so every other language must implement exactly these
 * keys (a missing key fails the build). Entries are either static strings or
 * functions for interpolation. Keep keys protocol-agnostic; both adapters use
 * them. New copy goes here first, then en.ts / yue.ts.
 */
export const zh = {
  // ── acks / queue (executor) ──
  ackReceived: "已接收",
  queuedAt: (pos: number) => `已排队 · 第 ${pos} 位`,
  queueFull: (max: number) => `队列已满（上限 ${max}），请稍后再试`,
  noCurrentProject: "无当前项目，请先用 /list_alive_projects 选择或 /add_project 新建",
  errorPrefix: (msg: string) => `错误：${msg}`,
  projectTag: (project: string) => `📂 ${project}`,

  // ── voice ──
  voiceLangTitle: "🎙️ 语音识别语言",
  voiceLangCardPrompt: (lang: string) => `当前(飞书)：**${lang}** · 点按钮切换`,
  autoDetect: "自动检测",
  voiceHeard: (text: string) => `🎙️ 你说的是：「${text}」`,
  voiceTranscribeFailed: "转写失败 · 请重试或改发文字",
  voiceEmpty: "没听清 · 请再说一遍或改发文字",
  voiceUnsupported: "语音转写仅支持 Apple Silicon",
  voiceNotInstalled: "语音转写未安装（在仓库运行 npm run whisper:install）",

  // ── project switch / remove / current ──
  currentProjectIs: (project: string) => `📂 当前项目：${project}`,
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
  btnInterrupt: "✋ 中断",
  btnRestart: "🔄 重启",
  btnClear: "🧹 clear",
  btnCompact: "🗜 compact",
  btnUp: "⬆️ up",
  btnDown: "⬇️ down",
  btnTab: "⇥ Tab",
  btnStatus: "📊 状态",
  btnStart: "🚀 启动",
  btnExit: "🚪 退出",
  btnPeek: "👁 peek",
  btnHistory: "📜 历史",
  btnQueue: "📋 队列",
  btnProjects: "📁 项目",
  btnRecent: "🕘 近期",
  btnCurrent: "📌 当前",
  btnSwitch: "🔀 切换",
  btnRemove: "🗑 删除",
  btnCreate: "➕ 创建",
  btnHelp: "💡 帮助",
  btnVoiceLang: "🎙️ 语音语言",
  btnUiLang: "🌐 界面语言",
  btnActiveMarker: "✅ 当前",
  btnMore: "⌨️ 更多控制 ▾",
  btnCollapse: "▴ 收起",
  btnCancel: "✕ 取消",
  btnDeleteMode: "🗑 删除…",

  // ── command results (dispatch) ──
  doneShort: "完成",
  claudeNotRunningRestart: "Claude 未运行，请使用 /restart 启动",
  contentTruncated: "...(内容过长，已截断)",
  claudeEmptyOutput: "Claude 返回空内容 · 用 /peek 查看画面",
  claudeStarted: "✅ Claude 已启动",
  claudeStartedWith: (label: string) => `✅ Claude 已用「${label}」启动`,
  startPickerTitle: "🚀 选择启动方式",
  startPickerPrompt: "配置了多个启动命令,选一个启动:",
  btnStartThis: "🚀 用这个启动",
  claudeExited: "✅ 已退出 Claude",
  claudeRestarted: "🔄 Claude 已重启 · --continue",
  sentEsc: "✅ 已发送 Esc",
  interrupted: "✅ 已中断 · Ctrl-C",
  clearedContext: "✅ 已清空上下文 · /clear",
  compactedContext: "✅ 已压缩上下文 · /compact",
  sentEnter: "✅ 已回车",
  sentUp: "✅ 已发送 ↑",
  sentDown: "✅ 已发送 ↓",
  sentTab: "✅ 已发送 Tab",
  statusRunning: "🟢 Claude 运行中",
  statusNotRunning: "🔴 Claude 未运行",

  // ── queue-status view ──
  queueGlobalHeader: "━━ 🌐 全局队列 ━━",
  queueCounts: (queued: number, processing: boolean) =>
    `排队中： ${queued} | 处理中： ${processing ? "🟢" : "🔴"}`,
  queueSessionHeader: "━━ 会话队列 ━━",
  queueNoSessions: "没有活跃的会话队列",
  queueLastDone: (s: number) => `上次完成： ${s}s 前`,
  queueTitle: "队列状态",

  // ── history / peek / placeholders ──
  paneTitle: "👁 tmux 画面",
  emptyPane: "（空）",
  historyTitle: "📜 历史记录",
  historyTitleShort: "历史记录",
  noPathMapping: "缺少项目路径映射 · 先用 /add_project 建立",
  noHistory: "没有找到对话历史",
  onlyNRounds: (n: number) => `只有 ${n} 条对话记录`,
  emptyOutput: "(无输出)",

  // ── project lists ──
  noCurrentProjectShort: "无当前项目",
  aliveListTitle: (n: number) => `活跃项目 (${n})`,
  aliveListEmpty: "没有活跃项目，用 /add_project <路径> 新建",
  recentListTitle: "近期项目",
  recentListTitleN: (n: number) => `近期项目 (${n})`,
  recentListEmpty: "没有近期项目，用 /add_project <路径> 添加",

  // ── project ops / add_project ──
  addProjectUsage: "用法：/add_project <路径>",
  addProjectUsageExample: "用法：/add_project <路径>\n\n示例：/add_project ~/projects/myapp",
  notADir: (p: string) => `${p} 不是目录`,
  dirNotExist: (p: string) => `目录不存在：${p}`,
  pathNotAllowedPath: (p: string) => `路径不在允许范围内：${p}`,
  alreadySwitched: "已存在 · 已切换",
  projectCreated: "项目已创建",
  projectCreatedPath: (p: string) => `项目已创建：${p}`,
  shortIdNotFound: (id: string) => `未找到短 id：${id}`,
  noCurrentProjectSet: "未设置当前项目\n\n用 /add_project <路径> 设置一个",
  currentActive: "✅ 当前活跃",
  currentNotFound: "🔴 未找到",
  currentProjectTitle: "当前项目",
  noRecentProjects: "没有近期项目\n\n用 /add_project <路径> 添加一个",
  messageTooLong: (len: number, max: number) => `消息过长 · ${len} > ${max} 字符`,
  onlyTextVoice: "暂仅支持文本和语音消息",
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
  failed: "失败",
  taskStillRunning: (body: string) => `⏳ 任务仍在进行中，请稍后通过 /peek 查看当前结果\n\n${body}`,
  taskStillRunningNotice: "⏳ 任务仍在进行中，完成后会自动推送结果 · /peek 查看当前画面",
  voiceDownloadFailed: "语音下载失败 · 网络波动,请重试",
  historyYou: "🧑‍💻 你",
  crashRecovered: (time: string) =>
    `♻️ tmux-claude-bot 异常重启 — 上次未正常退出（崩溃/被杀），已自动恢复 · ${time}`,

  // ── Telegram MSG (shared reply strings) ──
  noSession: "没有活跃会话 · 先 /list_alive_projects 或 /add_project",
  notRunning: "Claude 未运行 · /start 启动，或 /restart 继续",
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
  voiceLangInvalid: "🎙️ 用法：/voice_lang <en|zh|yue|auto 或 2-3 位语言代码>",

  // ── help intro (command-free preamble; command list is generated from command-catalog.ts) ──
  helpIntroTelegram: `🤖 tmux-claude-bot

发任意文字 → 转给 Claude → 返回结果
🎙️ 语音转写为可选功能 · /voice_install 启用（仅 Apple Silicon）· /voice_lang 设识别语言

提示：消息会收到 👀（已接收）/👍（完成）回应；处理中就地显示进度并编辑成结果；结果下方有 ⏎/✋/⎋/🔄 快捷按钮。`,

  helpIntroLark: `🤖 tmux-claude (Lark)

发任意文字 → 转给 Claude → 返回结果`,

  // ── help section headers ──
  helpSectionProjects: "📂 项目",
  helpSectionRunning: "⚡ 运行中",
  helpSectionIdle: "🚀 未运行",

  // ── command descriptions (used by command-catalog.ts to build help text) ──
  cmdCurrentProject: "当前项目",
  cmdListAlive: "活跃项目（点按切换/删除）",
  cmdListRecent: "近期项目",
  cmdAddProject: "新建项目",
  cmdQueueStatus: "队列状态",
  cmdHistory: "对话历史（默认最近一条）",
  cmdPeek: "查看 tmux 画面",
  cmdVoiceLang: "语音识别语言（英/中/粤/自动）",
  cmdLang: "界面语言（英/中/粤）",
  cmdEnter: "回车",
  cmdEsc: "Escape",
  cmdInterrupt: "Ctrl-C",
  cmdRestart: "重启 (--continue)",
  cmdClear: "清空上下文",
  cmdCompact: "压缩上下文",
  cmdArrowsTab: "方向键 / Tab",
  cmdExit: "退出",
  cmdStatus: "检查状态",
  cmdStart: "启动 Claude",
  cmdDoctor: "运行安装健康检查",
  cmdHelp: "本帮助",
  cmdWs: "工作区管理（save/use/list/remove）",

  // ── workspaces ──
  wsSaved: (name: string, session: string) => `✅ 已保存工作区「${name}」→ ${session}`,
  wsUsed: (name: string) => `✅ 已切换到工作区「${name}」`,
  wsRemoved: (name: string) => `✅ 已删除工作区「${name}」`,
  wsNotFound: (name: string) => `工作区「${name}」不存在`,
  wsSessionGone: (name: string) => `工作区「${name}」对应的会话已不存在`,
  wsNoCurrentProject: "无当前项目，请先用 /add_project 新建项目",
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
  groupCreatedShort: (label: string) => `✓ 已新建项目群「${label}」，去新群里继续。`,
  groupAlreadyExists: (label: string) =>
    `⚠️ 项目「${label}」已经有绑定群了，去那个群里用即可，无需重复创建。`,
};

// No `as const`: Messages widens to string / function types so other languages
// can provide their own copy while the KEY SET stays enforced.
export type Messages = typeof zh;
