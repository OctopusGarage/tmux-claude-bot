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
  btnLeft: "⬅️ left",
  btnRight: "➡️ right",
  btnTab: "⇥ Tab",
  btnStatus: "📊 状态",
  btnStart: "🚀 启动",
  btnExit: "🚪 退出",
  btnPeek: "👁 peek",
  btnHistory: "📜 历史",
  btnInputs: "🔁 重发",
  btnQueue: "📋 队列",
  btnDashboard: "📊 仪表盘",
  btnProjects: "📁 项目",
  btnRecent: "🕘 近期",
  btnCurrent: "📌 当前",
  btnAddProject: "➕ 新建项目",
  btnSwitch: "🔀 切换",
  btnRemove: "🗑 删除",
  btnCreate: "➕ 创建",
  btnHelp: "💡 帮助",
  btnVoiceLang: "🎙️ 语音语言",
  btnVoiceInstall: "🎙️ 安装语音",
  btnUiLang: "🌐 界面语言",
  btnActiveMarker: "✅ 当前",
  btnMore: "⌨️ 更多控制 ▾",
  btnCollapse: "▴ 收起",
  btnCancel: "✕ 取消",
  btnDeleteMode: "🗑 删除…",

  // ── adopt (take over a non-tmux agent) ──
  adoptTitle: "🧲 可接管的进程（不在 tmux 中）",
  adoptEmpty: "没有发现可接管的进程",
  adoptConfirmPrompt: (label: string) =>
    `确认接管？将先中断并结束原进程，再在 tmux 中续接：\n${label}`,
  btnAdoptConfirm: "🧲 接管",
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
  adoptGone: "该进程已不在可接管列表（已退出或已在 tmux 中）",
  adoptDone: (proj: string, resumed: boolean) =>
    resumed ? `✅ 已接管并续接会话：${proj}` : `✅ 已接管并新建会话：${proj}`,
  adoptFailed: "接管失败：进程无法结束或未能启动",
  adoptBusy:
    "目标 tmux 会话里已有程序在前台运行（另一个 agent 或其他程序）。已中止，未动原进程——请先去那边退出，再重新接管。",
  btnAdoptAttach: "💻 在电脑终端查看（可选）",
  adoptAttachHint: (cmd: string) =>
    `✅ 接入命令已经放进「电脑」的剪贴板了（不用在手机上复制）。回到电脑后，在任务终端里直接粘贴回车，就能进去查看——这一步是可选的。\n命令：${cmd}`,

  // ── command results (dispatch) ──
  doneShort: "完成",
  agentNotRunningRestart: "未运行，请使用 /restart 启动",
  contentTruncated: "...(内容过长，已截断)",
  agentEmptyOutput: "返回空内容 · 用 /peek 查看画面",
  agentStarted: "✅ 已启动",
  agentAlreadyRunning: "✅ 已在运行中，无需重复启动",
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
  queueItemGone: "该消息已不在队列（可能正在执行，可用 ✋ 中断停止）",
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
  noCurrentProjectSet: "未设置当前项目\n\n用 /add_project <路径> 设置一个",
  currentActive: "✅ 当前活跃",
  currentNotFound: "🔴 未找到",
  currentProjectTitle: "当前项目",
  noRecentProjects: "没有近期项目\n\n用 /add_project <路径> 添加一个",
  messageTooLong: (len: number, max: number) => `消息过长 · ${len} > ${max} 字符`,
  onlyTextVoice: "暂仅支持文本和语音消息",
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

提示：消息会收到 👀（已接收）/👍（完成）回应；处理中就地显示进度并编辑成结果；结果下方有 ⏎/✋/⎋/🔄 快捷按钮。`,

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
  cmdCurrentProject: "当前项目",
  cmdListAlive: "活跃项目（点按切换/删除）",
  cmdListRecent: "近期项目",
  cmdAddProject: "新建项目",
  cmdNewFree: "新建自由项目（同目录可并行）",
  freeProjectLimit: (max: number) => `自由项目已达上限 ${max} 个，请先删除一个再试。`,
  freeProjectCreated: (slot: number, label: string | null) =>
    `🆓 已创建自由项目 #${slot}${label ? `（${label}）` : ""}\n可 /cd 到任意目录并自行启动 agent；/list_alive_projects 可切回。`,
  btnNewFree: "🆓 新建自由项目",
  freeLabelPrompt: "请输入自由项目名称（发送 - 跳过命名）",
  freeLabelCancelled: "已取消",
  cmdAdopt: "接管 tmux 外的 agent",
  cmdQueueStatus: "队列状态",
  cmdHistory: "对话历史（默认最近一条）",
  cmdPeek: "查看 tmux 画面",
  cmdVoiceLang: "语音识别语言（英/中/粤/日/西/自动）",
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

  // ── dashboard / batch ──
  cmdHome: "切换到主控操作员会话（未选项目时的默认目标）",
  homeOperatorDisabled: "未启用主控操作员会话",
  homeOperatorSwitched: "🏠 已切换到主控操作员会话",
  cmdDashboard: "查看全局仪表盘（所有会话状态总览）",
  cmdBatch: "批量调度器：查看状态或控制批次运行（start/pause/resume/stop/report）",
  cmdSysload: "查看本机负载/发热/跑飞进程",
  sysloadTitle: "🖥 系统负载",
  dashboardTitle: "📊 仪表盘",
  autopilotTitle: "🤖 Autopilot",
  autopilotNotifyPaused: (session: string, reason: string) =>
    `🛑 autopilot 已暂停 [${session}]：${reason}`,
  autopilotNotifyStopped: (session: string, reason: string) =>
    `⏹️ autopilot 已停止 [${session}]：${reason}`,
  autopilotNotifyUsage: (session: string, pct: number) =>
    `🛑 autopilot 目标暂停 [${session}]：用量达 ${pct}% 阈值`,
  autopilotNotifyMaxIter: (session: string) => `⏹️ autopilot 目标停止 [${session}]：已达最大迭代`,
  autopilotNotifyWallClock: (session: string) => `⏹️ autopilot 目标停止 [${session}]：已达时长上限`,
  autopilotNotifyAwaitHuman: (session: string) =>
    `🎯 autopilot [${session}]：阶段判定完成，请确认（/autopilot confirm）或继续（/autopilot reject）`,
  autopilotNotifyGoalComplete: (session: string, goalId: string) =>
    `✅ autopilot 目标完成 [${session}]：${goalId}（请确认）`,
  autopilotNotifyCycleComplete: (session: string, rounds: number) =>
    `✅ autopilot 循环完成 [${session}]：已跑满 ${rounds} 轮（请确认）`,
  autopilotNotifyKeepaliveDone: (session: string) =>
    `✅ autopilot 保活任务完成 [${session}]：检测到完成标记`,
  autopilotNotifyGoalAdvance: (
    session: string,
    goalId: string,
    pos: number,
    total: number,
    round: number,
    rounds: number,
  ) => `➡️ autopilot [${session}]：进入目标 ${goalId}（${pos}/${total} · 第 ${round}/${rounds} 轮）`,
  batchRunStarted: (planId: string, tasks: number) =>
    `🚀 批次运行已启动：计划 ${planId}，共 ${tasks} 个任务`,
  batchPoolPaused: (agent: string, resumeAt: string) =>
    `⏸ 批次池已暂停 [${agent}]：额度已达上限，预计恢复 ${resumeAt}`,
  batchRunComplete: (summary: string) => `✅ 批次运行完成\n${summary}`,
  autopilotGlobal: (on: boolean): string =>
    on
      ? "已开启全局托管:所有活跃会话自动保活(某个会话用 /autopilot off 单独退出)"
      : "已关闭全局托管",
  autopilotStatus: (o: {
    enabled: boolean;
    pureKeepAlive: boolean;
    iterations: number;
    persona: string;
    goal?: { id: string; phaseIndex: number };
  }) =>
    `Autopilot：${o.enabled ? "开" : "关"}（${o.pureKeepAlive ? "纯保活" : "随目标"}，已干预 ${o.iterations} 次，persona=${o.persona}）${o.goal ? `（目标 ${o.goal.id}#${o.goal.phaseIndex}）` : ""}`,
  autopilotUsage: (raw: string) =>
    `未知子命令「${raw}」。用法：/autopilot [on|off|keepalive on|off|stop|goals <ids> [rounds N]|goal <id>|confirm|reject|global on|off]`,
  btnApEnable: "🤖 开启智能托管",
  btnApDisable: "⏹ 关闭智能托管",
  btnApPickGoals: "🎯 选目标",
  btnApGlobalOn: "🌐 全局:开",
  btnApGlobalOff: "🌐 全局:关",
  btnApStop: "⏹ 停止目标",
  btnApConfirm: "✅ 确认完成",
  btnApContinue: "▶️ 继续打磨",
  btnApBack: "↩︎ 返回",
  btnApRoundsMinus: "➖",
  btnApRoundsPlus: "➕",
  btnApStartCycle: (n: number, rounds: number) => `▶️ 开始(${n} 个目标 · ${rounds} 轮)`,
  apRoundsLabel: (rounds: number) => `轮数:${rounds}`,
  goalTestCoverage: "提升测试覆盖",
  goalFixTests: "修复测试",
  goalCodeReview: "代码评审",
  goalAddFeature: "添加功能",
  goalRefactorElegant: "重构为优雅专业",
  goalUiPolish: "打磨界面",
  autopilotGoalStarted: (id: string) => `已启动目标：${id}`,
  autopilotUnknownGoal: (ids: string) => `未知目标。可用：${ids}`,
  goalsTitle: "🎯 目标预设",
  noLogsContext: "无当前项目，请先选择项目或指定 trace（/logs <traceId>）。",

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
  groupPinnedNoSwitch: (label: string) =>
    `🔒 本群已固定绑定「${label}」，不能切换到其他项目。如需更换，请用 🗂 → 改绑。`,
  groupNoRemoveInGroup: "🔒 在群里不能删除项目（会影响他人）。请到与机器人的私聊里删除。",
  groupFreePickerTitle: "🆓 新建自由项目群（可与现有群同目录）",
  groupOverviewTitle: "🗂 项目群",
  groupOverviewExisting: "已有项目群：",
  groupOverviewNoGroups: "暂无项目群。",
  groupOverviewItem: (label: string, path: string) => `• **${label}** — \`${path}\``,
  btnFreeGroup: "🆓 平行群",
  freeGroupCreated: (label: string) => `🆓 已创建平行群「${label}」`,
};

// No `as const`: Messages widens to string / function types so other languages
// can provide their own copy while the KEY SET stays enforced.
export type Messages = typeof zh;
