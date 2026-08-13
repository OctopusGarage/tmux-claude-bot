import { UI_ICONS } from "../../../shared/ui/icons.js";
import type { Messages } from "./zh.js";

/** English catalog. Typed `: Messages`, so it must implement every key in zh.ts. */
export const en: Messages = {
  ackReceived: "Received",
  queuedAt: (pos) => `Queued · #${pos}`,
  queueFull: (max) => `Queue full (max ${max}) — try again shortly`,
  noCurrentProject:
    "No current session — pick one with /list_alive_projects or create one with /add_project",
  errorPrefix: (msg) => `Error: ${msg}`,
  projectTag: (project) => `📂 ${project}`,

  voiceLangTitle: "🎙️ Voice language",
  voiceLangCardPrompt: (lang) => `Current (Feishu): **${lang}** · tap to switch`,
  autoDetect: "auto-detect",
  voiceHeard: (text) => `🎙️ You said: “${text}”`,
  voiceHeardTranslated: (original, translated) =>
    `🎙️ You said: “${original}”\n🌐 Sending English: “${translated}”`,
  promptTranslateTitle: `${UI_ICONS.feature.translate} Translation mode`,
  promptTranslateCardPrompt: (mode) => `Current: **${mode}** · tap to switch`,
  voiceTranscribeFailed: "Transcription failed · retry or send text",
  voiceTranslateFailed: "Translation failed · retry or send text",
  promptTranslateFailed: "Translation failed · retry or disable prompt translation",
  promptTranslatedSent: (from, to) => `Translated and sent ${from}->${to}`,
  promptTranslateAlreadyInstalled: "🌐 Prompt translation dependencies are ready",
  promptTranslateInstalling:
    "🌐 Installing prompt translation dependencies · first run downloads the model, hold on…",
  promptTranslateInstallOk:
    "🌐 Prompt translation dependencies are ready · you can enable translation mode now",
  promptTranslateInstallFailed: (e) =>
    `🌐 Install failed · ${e} · run npm run translate:install on the host for details`,
  promptTranslateCommandUsage: (usage) => `Usage: /prompt_translate ${usage}`,
  promptTranslateUnavailable: (error) => `Prompt translation unavailable: ${error}`,
  promptTranslateDisabledFor: (source) => `Prompt translation disabled for ${source}`,
  promptTranslateStatusOff: (source) => `Prompt translation for ${source}: off`,
  promptTranslateStatusLine: (source, from, to) =>
    `Prompt translation for ${source}: argos ${from}->${to}`,
  promptTranslateEnabledLine: (line) => `Enabled. ${line}`,
  voiceEmpty: "Didn’t catch that · say it again or send text",
  voiceUnsupported: "Voice transcription needs Apple Silicon",
  voiceNotInstalled: "Voice not installed (run `npm run whisper:install` in the repo)",

  currentProjectIs: (project) => `${UI_ICONS.session.current} Current session: ${project}`,
  projectStatusSession: (alive) =>
    `${alive ? UI_ICONS.session.active : UI_ICONS.session.stopped} Session: ${alive ? "running" : "stopped"}`,
  projectStatusAgent: (agent, running, busy) =>
    agent
      ? `${running ? (busy ? UI_ICONS.session.busy : UI_ICONS.agent.generic) : UI_ICONS.session.stopped} Agent: ${agent}${running ? (busy ? " busy" : " idle") : " stopped"}`
      : `${UI_ICONS.agent.none} Agent: none`,
  projectStatusType: (isFree) =>
    `${isFree ? UI_ICONS.session.independent : UI_ICONS.session.regular} Type: ${isFree ? "independent session" : "regular session"}`,
  projectStatusGroup: (label) =>
    `${label ? UI_ICONS.group.projectGroup : UI_ICONS.group.none} Group: ${label ?? "none"}`,
  projectStatusLine: (session, agent, type, group) => `${session} · ${agent} · ${type} · ${group}`,
  switched: "Switched",
  switchedTo: (project) => `Switched to: ${project}`,
  removed: "Removed",
  nestingWarning:
    '⚠️ This is tmux-claude-bot\'s own repo — driving it via the bot usually nests (only "received", no result). Switch to a real project.',

  uiLangTitle: "🌐 Interface language",
  uiLangCurrent: (lang) => `Interface language: ${lang} · tap to switch`,
  uiLangSet: (lang) => `Interface language set to ${lang}`,

  helpTitle: "Help",
  helpRunning: "**⚡ Running**",
  helpProjects: "**📂 Projects / Views**",

  btnEnter: "⏎ Enter",
  btnEsc: "⎋ Esc",
  btnInterrupt: `${UI_ICONS.action.interrupt} Interrupt`,
  btnRestart: "🔄 Restart",
  btnClear: `${UI_ICONS.action.clear} clear`,
  btnCompact: `${UI_ICONS.action.compact} compact`,
  btnUp: "⬆️ up",
  btnDown: "⬇️ down",
  btnLeft: "⬅️ left",
  btnRight: "➡️ right",
  btnTab: "⇥ Tab",
  btnStatus: "📊 Status",
  btnStart: "🚀 Start",
  btnResume: "🔄 Resume",
  btnExit: `${UI_ICONS.action.exit} Exit`,
  btnPeek: "👁 peek",
  btnHistory: "📜 History",
  btnInputs: "🔁 Re-run",
  btnQueue: `${UI_ICONS.tone.queue} Queue`,
  btnDashboard: "📊 Dashboard",
  btnProjects: "🟢 Active sessions",
  btnRecent: "🕘 Recent",
  btnCurrent: "📌 Current session",
  btnAddProject: "➕ New project",
  btnSwitch: "🔀 Switch",
  btnRemove: "🗑 Delete",
  btnCreate: "➕ Create",
  btnHelp: "💡 Help",
  btnVoiceLang: "🎙️ Voice",
  btnVoiceInstall: "🎙️ Install voice",
  btnPromptTranslate: `${UI_ICONS.feature.translate} Translate`,
  btnPromptTranslateOff: "⏻ Off",
  btnPromptTranslateInstall: `${UI_ICONS.feature.translate} Install translation`,
  btnUiLang: "🌐 Language",
  btnActiveMarker: "✅ Current",
  btnMore: "⌨️ More ▾",
  btnCollapse: "▴ Collapse",
  btnCancel: "✕ Cancel",
  btnConfirmAction: (action) => `Confirm ${action}`,
  btnDeleteMode: "🗑 Delete…",
  confirmActionBody: (action, impact, target) =>
    `Confirm action: ${action}\n\nTarget: ${target}\nImpact: ${impact}\n\nConfirm to continue.`,
  confirmImpactExit: "Exits the current agent and clears that session's waiting queue.",
  confirmImpactRestart: "Interrupts and restarts the current agent; unsent input may be lost.",
  confirmImpactClear: "Sends /clear and resets the current agent context.",
  confirmImpactCompact: "Sends /compact and compacts the current agent context.",

  // ── adopt (take over an unmanaged agent) ──
  adoptTitle: "🧲 Adoptable unmanaged processes",
  adoptEmpty: "No adoptable processes found",
  adoptConfirmPrompt: (label: string) =>
    `Take over? The original process is interrupted and ended first, then resumed in a managed session:\n${label}`,
  btnAdoptConfirm: "🧲 Take over",
  btnAdoptAsFree: `${UI_ICONS.session.independent} Take over as independent session`,
  btnAdoptCancel: "✕ Cancel",
  adoptCancelled: "Takeover cancelled",
  adoptWorking: "Taking over…",
  recoverEmpty: "No projects to recover.",
  cmdInputs: "Fetch a recent input to edit",
  inputsTitle: "📝 Recent inputs (tap to fetch & edit)",
  inputsEmpty: "No recent inputs to re-run",
  inputsExpired: "List expired — send /inputs again",
  inputDraftToast: "✏️ Fetched as a draft — edit, then send",
  recoverAllRunning: (count: number, list: string) =>
    `🟢 All ${count} project(s) are running — nothing to recover:\n\n${list}`,
  btnRecover: "🔄 Recover",
  recoverPreview: (count: number, alive: number, list: string) =>
    `🔄 Will recover ${count} project(s)${alive > 0 ? ` (${alive} already running, skipped)` : ""}\n\n${list}\n\nConfirm recovery?`,
  btnRecoverConfirm: "🔄 Confirm recovery",
  recoverWorking: "Recovering…",
  recoverCancelled: "Recovery cancelled.",
  recoverBusy: "A recovery is already in progress.",
  recoverDone: (launched: number, shellOnly: number, alive: number, failed: number) =>
    `🔄 Recovery complete\n\n🔁 ${launched} relaunched${shellOnly > 0 ? ` · 🐚 ${shellOnly} recreated` : ""} · 🟢 ${alive} running${failed > 0 ? ` · ⚠️ ${failed} failed` : ""}`,
  adoptGone: "That process is no longer adoptable (exited or already managed)",
  adoptDone: (proj: string, resumed: boolean) =>
    resumed ? `✅ Adopted and resumed session: ${proj}` : `✅ Adopted and started fresh: ${proj}`,
  adoptFailed: "Takeover failed: process would not end, or the agent did not start",
  adoptAgentDidNotStart:
    "Takeover failed: the original process ended, but the agent did not start in the managed session. Use /peek to inspect the pane, fix the shell prompt or startup command, then retry.",
  adoptBusy:
    "The target session already has a program in the foreground (another agent or something else). Aborted without touching the original — please exit it there first, then adopt again.",
  adoptProjectRunning:
    "A same-path project is already running Claude/Codex. Aborted without touching the original — use “Take over as independent session” if you want a parallel takeover.",
  btnAdoptAttach: "💻 View in computer terminal (optional)",
  adoptAttachHint: (cmd: string) =>
    `✅ Run this optional command in a computer terminal to view the session:\nCommand: ${cmd}`,

  doneShort: "Done",
  agentNotRunningRestart: "Not running — use /resume to restore it, or /start for a new session",
  contentTruncated: "...(content too long, truncated)",
  agentEmptyOutput: "Returned nothing · /peek to view the pane",
  agentReplyUnavailable:
    "No valid agent reply was captured · use /peek to inspect the pane, then retry if needed.",
  agentStarted: "✅ Started",
  agentResumed: "🔄 Resumed the previous session",
  agentResumeMissingState: "No resumable previous session state — use /start to create a new one.",
  agentAlreadyRunning: "✅ Already running",
  agentInputNotReady:
    "The agent is not ready to receive input yet. Try again shortly; if it keeps happening, restart this session.",
  projectAutomationBusy: (taskKind, projectId, runId, supervisor) =>
    `Project automation is running, so ordinary messages are blocked for now.\nTask: ${taskKind}\nProject: ${projectId}\nRun: ${runId}\nSupervisor: ${supervisor}\n\nWait for the task to finish, or inspect/cancel it before continuing.`,
  agentStartedWith: (label) => `✅ Started with "${label}"`,
  startPickerTitle: "🚀 Choose how to start",
  startPickerPrompt: "Multiple start commands are configured — pick one:",
  btnStartThis: "🚀 Start this one",
  agentExited: "✅ Exited",
  agentRestarted: "🔄 Restarted",
  sentEsc: "✅ Sent Esc",
  interrupted: "✅ Interrupted · Ctrl-C",
  clearedContext: "✅ Context cleared · /clear",
  compactedContext: "✅ Context compacted · /compact",
  sentEnter: "✅ Sent Enter",
  sentUp: "✅ Sent ↑",
  sentDown: "✅ Sent ↓",
  sentLeft: "✅ Sent ←",
  sentRight: "✅ Sent →",
  sentTab: "✅ Sent Tab",
  statusRunning: (agent) => `🟢 ${agent} running`,
  statusNotRunning: (agent) => `🔴 ${agent} not running`,
  statusContext: (bar, pct) => `📊 Context ${bar} ${pct}%`,
  statusFiveHour: (bar, pct, reset) => `⏱ Session (5h) ${bar} ${pct}% (resets ${reset})`,
  statusSevenDay: (bar, pct, reset) => `📅 Weekly ${bar} ${pct}% (resets ${reset})`,
  statusUsageStale: (mins) => `⚠️ Usage data is ${mins} min stale (the agent may have exited)`,

  // -- status usage install --
  statusUsageHint: "💡 Want to see usage? Send /status_install to set it up",
  statusUsagePending: "📊 Usage data not available yet — shown after the next Claude API call",
  statusUsageNoData: "📊 No usage data for this session yet · send a message to refresh",
  statusModeApi: "API",
  statusModeSubscription: "subscription",
  statusApiLine: (mode, host) => `🔌 ${mode} · ${host}`,
  statusInstallTitle: "📊 Usage reporting install",
  statusInstallNoClaude:
    "No running Claude detected. Usage-report install is for Claude only \u2014 Codex reports usage natively in its session log, so nothing to install.",
  statusInstallInstalled: (dir) => `✅ ${dir} usage reporting installed`,
  statusInstallAlready: (dir) => `⏭ ${dir} already installed`,
  statusInstallForeignPrompt: (dirs) =>
    `⚠️ These dirs already have a custom statusLine — how to handle? Wrap is recommended (keeps your statusLine, adds usage reporting).\n${dirs.join("\n")}`,
  statusInstallOverwritten: (dir, backup) => `🔁 ${dir} overwritten (backup: ${backup})`,
  statusInstallWrapped: (dir, backup) =>
    `📦 ${dir} wrapped: keeps your display + adds usage\n   ⚠️ Your statusLine now runs through this bot's wrapper; if the bar breaks, restore from: ${backup}`,
  statusInstallSnippet: (dir, snippet) =>
    `✍️ ${dir}: add this to your statusline script (it must do input=$(cat)):\n${snippet}`,
  statusInstallSkipped: (dir) => `✖️ ${dir} skipped`,
  statusInstallError: (dir, msg) => `❌ ${dir}: ${msg}`,
  btnStatusInstall: "📊 Install usage",
  btnStatusOverwrite: "🔁 Overwrite",
  btnStatusWrap: "📦 Wrap (recommended)",
  btnStatusSnippet: "✍️ Give snippet",
  btnStatusSkip: "✖️ Skip",
  queueGlobalHeader: "━━ 🌐 Global queue ━━",
  queueCounts: (queued, processing) =>
    `Queued: ${queued} | Processing: ${processing ? "🟢" : "🔴"}`,
  queueSessionHeader: "━━ Session queues ━━",
  queueNoSessions: "No active session queues",
  queueLastDone: (s) => `last done ${s}s ago`,
  queueItemCancelled: "queued message cancelled",
  queueItemRewritten: "queued message rewritten",
  queueItemGone: `that message is no longer queued (it may be running — use ${UI_ICONS.action.interrupt} interrupt to stop it)`,
  queueTitle: "Queue status",

  paneTitle: "👁 Session pane",
  emptyPane: "(empty)",
  historyTitle: "📜 History",
  historyTitleShort: "History",
  noPathMapping: "No path mapping · create it with /add_project first",
  noHistory: "No conversation history found",
  onlyNRounds: (n) => `Only ${n} conversation(s)`,
  emptyOutput: "(no output)",

  noCurrentProjectShort: "No current session",
  aliveListTitle: (n) => `Active sessions (${n})`,
  aliveListEmpty: "No active sessions — create one with /add_project <path>",
  recentListTitle: "Recent projects",
  recentListTitleN: (n) => `Recent projects (${n})`,
  recentListEmpty: "No recent projects — add one with /add_project <path>",

  notADir: (p) => `${p} is not a directory`,
  dirNotExist: (p) => `Directory not found: ${p}`,
  pathNotAllowedPath: (p) => `Path not allowed: ${p}`,
  alreadySwitched: "Already exists · switched",
  projectCreated: "Project created",
  projectCreatedPath: (p) => `Project created: ${p}`,
  projectPathCollision: (p) =>
    `⚠️ This directory's session name collides with an existing project (${p}). Rename one to use both.`,
  browseTitle: "📂 Choose a project location",
  browseRootsTitle: "📂 Choose a starting directory",
  browseEmpty: "(no subdirectories)",
  browseUnreadable: "⚠️ Cannot read this directory",
  browseCancelled: "Cancelled",
  btnBrowseUp: "⬆️ Up",
  btnBrowseCreate: "✅ Create project here",
  btnBrowseCancel: "✖️ Cancel",
  btnBrowseNewFolder: "➕ New folder",
  browseNewFolderPrompt: (p) => `Reply with the name of the new folder to create in ${p}`,
  browseNewFolderInvalid: "❌ Invalid name (cannot be empty or contain “/”)",
  browseNewFolderExists: "❌ That name already exists",
  browseNewFolderError: "❌ Failed to create the folder",
  shortIdNotFound: (id) => `Short id not found: ${id}`,
  noCurrentProjectSet: "No current session set\n\nSet one with /add_project <path>",
  currentProjectTitle: "Current session",
  noRecentProjects: "No recent projects\n\nAdd one with /add_project <path>",
  messageTooLong: (len, max) => `Message too long · ${len} > ${max} chars`,
  onlyTextVoice: "Only text and voice messages are supported",
  handlerErrorTelegram: "⚠️ Something went wrong handling that message; please retry.",
  handlerError:
    "⚠️ Something went wrong handling that message; please retry. If the group stops responding, send /restore to reconnect the project.",
  unknownCommand: (name) => `Unknown command: /${name} (send /help for the list)`,

  toastProcessing: "➕ Working…",
  sessionGone: "Session not found or already ended",
  toastSwitched: "✅ Switched",
  toastRemoving: "🗑 Removing…",
  toastSent: (action) => `Sent /${action}`,
  toastError: "Something went wrong",

  processingQueued: (pos) => `Working · queue #${pos}`,
  processing: "Working",
  duplicateIgnored: "Duplicate ignored — your identical message is already being processed",
  failed: "Failed",
  taskStillRunning: (body) => `⏳ Task still running · /peek to see the current result\n\n${body}`,
  taskStillRunningNotice:
    "⏳ Still running — the result will be pushed automatically when it finishes · /peek for a live look",
  voiceDownloadFailed: "Voice download failed · network hiccup, please retry",
  historyYou: "🧑‍💻 You",
  crashRecovered: (time) =>
    `♻️ tmux-claude-bot recovered from an unclean exit (crash / kill) · ${time}`,

  noSession: "No active session · /list_alive_projects or /add_project first",
  notRunning: "Not running · /start to launch, or /restart to continue",
  noShortId: (id) => `Short ID not found: ${id}`,
  pathNotAllowed: (dirs) => `Path not in the allow-list · allowed: ${dirs.join(", ")}`,
  voiceNotEnabled:
    "🎙️ Voice not enabled · send /voice_install (Apple Silicon only), or run `npm run whisper:install` on the host",
  voiceNeedsAppleSilicon:
    "🎙️ Voice transcription needs Apple Silicon (macOS arm64) · this host can't, send text instead",
  voiceAlreadyInstalled: "🎙️ Voice is ready · just send a voice message",
  voiceInstalling: "🎙️ Installing voice · first run downloads deps (~1-2 min), hold on…",
  voiceInstallOk: "🎙️ Voice is ready · you can send voice messages now",
  voiceInstallFailed: (e) =>
    `🎙️ Install failed · ${e} · run \`npm run whisper:install\` on the host for details`,
  voiceLangCurrent: (lang) =>
    `🎙️ Recognition language: ${lang === "auto" ? "auto-detect" : lang} · tap below to switch`,
  voiceLangSet: (lang) =>
    `🎙️ Recognition language set to ${lang === "auto" ? "auto-detect" : lang} · next voice message`,
  voiceLangInvalid: "🎙️ Usage: /voice_lang <en|zh|yue|ja|es|auto or a 2-3 letter code>",

  helpIntroTelegram: `🤖 tmux-claude-bot

Send any text → forwarded to the agent → reply
🎙️ Voice transcription is optional · /voice_install to enable (Apple Silicon only) · /voice_lang to set the language

Tip: messages get 👀 (received) / 👍 (done) reactions; progress shows in place and is edited into the result; the result has ⏎/${UI_ICONS.action.interrupt}/⎋/🔄 shortcut buttons below it.`,

  helpIntroLark: `🤖 tmux-claude (Lark)

Send any text → forwarded to the agent → reply`,

  helpSectionProjects: "📂 Projects",
  helpSectionSession: "▶️ Session",
  helpSectionGroups: "👥 Groups",
  helpSectionSettings: "⚙️ Settings",
  helpSectionDiagnostics: "🛠 Diagnostics",
  helpSectionRunning: "⚡ Running",
  helpSectionIdle: "🚀 Not running",

  cmdCurrentProject: "current session",
  cmdListAlive: "active sessions (tap to switch/delete)",
  cmdListRecent: "recent projects",
  cmdAddProject: "create a project",
  cmdNewFree: "New independent session (parallel, same workspace OK)",
  freeProjectLimit: (max) => `Independent-session limit reached (${max}). Remove one first.`,
  freeProjectCreated: (slot, label) =>
    `${UI_ICONS.session.independent} Independent session #${slot}${label ? ` (${label})` : ""} created.\n/cd anywhere and start the agent yourself; /list_alive_projects to switch back.`,
  btnNewFree: `${UI_ICONS.session.independent} New independent session`,
  freeLabelPrompt: "Send a name for the independent session (send - to skip naming)",
  freeLabelCancelled: "Cancelled",
  cmdAdopt: "adopt an unmanaged agent",
  cmdQueueStatus: "queue status",
  cmdHistory: "conversation history (latest by default)",
  cmdPeek: "view the session pane",
  cmdVoiceLang: "voice recognition language (en/zh/yue/ja/es/auto)",
  cmdPromptTranslate: "prompt translation (status/off/on from to)",
  cmdTranslateInstall: "install prompt translation dependencies",
  cmdLang: "interface language (en/zh/zh-TW/yue/ja/es)",
  cmdEnter: "Enter",
  cmdEsc: "Escape",
  cmdInterrupt: "Ctrl-C",
  cmdRestart: "restart (--continue)",
  cmdClear: "clear context",
  cmdCompact: "compact context",
  cmdArrowsTab: "arrow keys / Tab",
  cmdExit: "exit",
  cmdStatus: "check status",
  cmdStart: "start the agent",
  cmdResume: "resume the previous agent session",
  cmdDoctor: "run install health checks",
  cmdRecover: "Recover all projects after a reboot",
  cmdStatusInstall: "Install usage reporting for /status",
  cmdVoiceInstall: "Install voice transcription (Apple Silicon)",
  cmdHelp: "this help",
  cmdWs: "workspace management (save/use/list/remove)",

  // ── workspaces ──
  wsSaved: (name, session) => `✅ Saved workspace "${name}" → ${session}`,
  wsUsed: (name) => `✅ Switched to workspace "${name}"`,
  wsRemoved: (name) => `✅ Removed workspace "${name}"`,
  wsNotFound: (name) => `Workspace "${name}" not found`,
  wsSessionGone: (name) => `Workspace "${name}" session no longer exists`,
  wsNoCurrentProject: "No current session — use /add_project first",
  wsListEmpty: "No saved workspaces",
  wsListTitle: "📎 Workspaces",
  wsListItem: (name, session) => `• **${name}** → ${session}`,
  wsInvalidName: "Workspace name: letters, digits, hyphens and underscores only (1-32 chars)",
  wsUsage: "Usage: /ws <save <name> | use <name> | list | remove <name>>",

  // ── sessions ──
  noSessions: "No saved sessions found",
  sessionsTitle: (n) => `${n} saved sessions — tap to resume`,
  sessionsLabel: (id, ago) => `${id} · ${ago}`,
  resumeStarted: (id) => `✅ Resumed session ${id}`,
  cmdSessions: "Browse and resume past sessions",

  // ── logs ──
  cmdLogs: "View recent warning/error logs (/logs <traceId|N>)",
  logsTitle: "🪵 Recent logs",

  // ── prompt library ──
  cmdPrompts: "Browse saved prompts",
  promptsDisabled: "Prompt library not enabled (set PROMPT_MCP_COMMAND in .env)",
  promptsEmpty: "No matching prompts",
  promptsError: "Prompt library connection failed — try again later",
  promptsGone: "That prompt no longer exists — search again",
  promptsTitle: (n) => `🔖 Prompt library (${n})`,
  promptsOpen: "View/Copy",
  promptsSearchTitle: (q, n) => `🔖 "${q}" — ${n} match${n === 1 ? "" : "es"}`,
  promptsRefine: (shown, total) =>
    `${total} total — showing first ${shown}. Use /prompts <keyword> to narrow`,
  promptsAll: "✖ All",
  promptsPrev: "◀ Prev",
  promptsNext: "Next ▶",

  // ── dashboard ──
  cmdHome: "Switch to the home operator session (default target when no project is selected)",
  homeOperatorDisabled: "Home operator session is not enabled",
  homeOperatorSwitched: "🏠 Switched to the home operator session",
  cmdDashboard: "View the global dashboard (overview of all sessions)",
  cmdAutopilot: "Delegate the current session's work to the Loop Supervisor",
  cmdOpportunity: "Review and discuss proactive opportunity suggestions",
  cmdSysload: "Show machine load, heat, runaway processes, and Resource Guardian",
  sysloadTitle: "🖥 System load",
  dashboardTitle: "📊 Dashboard",
  dashboardOverallHealth: "Overall Health",
  dashboardAttention: "Attention",
  dashboardActiveWork: "Active Work",
  dashboardAutomation: "Automation",
  dashboardOperatorAi: "Operator and AI Interfaces",
  dashboardRuntimeDomains: "Runtime Domains",
  dashboardRecentOutcomes: "Recent Outcomes",
  dashboardProjectSessions: "Project Sessions",
  dashboardNone: "none",
  dashboardMore: "more",
  dashboardEnabled: "enabled",
  dashboardIdle: "idle",
  dashboardShown: "shown",
  dashboardHealthy: "healthy",
  dashboardSession: "session",
  dashboardSkills: "skills",
  dashboardMcpProfiles: "MCP profiles",
  dashboardPromptLibrary: "Prompt Library",
  dashboardSessions: "sessions",
  dashboardRunning: "running",
  dashboardBusy: "busy",
  dashboardQueue: "queue",
  dashboardUp: "up",
  dashboardNoAdapters: "none",
  dashboardRuntimeDomain: (id: string) =>
    ({
      "work-orders": "WorkOrders",
      "repository-reviews": "Repository PR Reviews",
      automation: "Automation",
      "daily-task-audit": "Daily Task Audit",
      "runtime-guardian": "Runtime Guardian",
      "resource-guardian": "Resource Guardian",
      "agent-capacity": "Agent Capacity",
      power: "Service and Power",
      "operator-ai": "Operator and AI Interfaces",
    })[id] ?? id,
  dashboardHealthHealthy: "healthy",
  dashboardHealthAttention: "attention",
  dashboardHealthDegraded: "degraded",
  dashboardAttentionOperatorSession: "Home Operator Session needs attention",
  dashboardAttentionOperatorSkills: (installed: number, expected: number) =>
    `Home Operator skills ${installed}/${expected} ready`,
  dashboardAttentionOperatorMcp: (installed: number, expected: number) =>
    `Managed MCP profiles ${installed}/${expected} ready`,
  dashboardAttentionOperatorPrompt: "Configured Prompt Library is unavailable",
  dashboardAttentionWorkOrderFailed: (project: string, _taskKind: string) =>
    `${project} WorkOrder failed`,
  dashboardAttentionWorkOrderAbandoned: (project: string) => `${project} WorkOrder is abandoned`,
  dashboardAttentionWorkOrderStale: (project: string) => `${project} WorkOrder dispatch is stale`,
  dashboardAttentionAutomationDependency: (automation: string) =>
    `${automation} has a disabled dependency`,
  dashboardAttentionDailyAudit: (count: number) => `${count} Daily Task Audit item needs attention`,
  dashboardAttentionRuntimeFinding: (project: string, _findingKind: string) =>
    `${project} has a Runtime Guardian finding`,
  dashboardAttentionResourcePressure: (_pressure: string, _circuit: string) =>
    "Resource Guardian needs attention",
  dashboardAttentionAgentCapacity: (agent: string, state: string) =>
    `${agent} capacity is ${state}`,
  dashboardAttentionPowerPolicy: (_mode: string, _phase: string, _schedule: string) =>
    "Power policy needs attention",
  dashboardAttentionRepositoryReview: (project: string, status: string, retryEpoch: number) =>
    status === "retry-wait"
      ? `${project} is retrying automatically (epoch ${retryEpoch})`
      : status === "manual-review"
        ? `${project} has a verified human boundary`
        : `${project} repository PR review retry budget is exhausted`,
  autopilotTitle: `${UI_ICONS.feature.autopilot} Autopilot`,
  autopilotDelegatePanelBody:
    "Delegate the current session context to the Loop Supervisor. Start immediately when the scope is already clear, or review the plan first when you want an explicit checklist and stop conditions before execution.",
  autopilotUsage: (raw) =>
    `Unknown subcommand "${raw}". Usage: /autopilot [requirement] or /autopilot delegate [requirement]`,
  autopilotPlanPreviewBody:
    "Plan before delegation\n\nObjective: continue the current user-confirmed task from the live session and repository state until it is genuinely complete.\n\nChecklist: inspect live context, git status, recent commits, existing PRs, and prior verification; identify what remains; make only necessary changes; review the diff; run relevant local verification, coverage review for touched risk paths, and existing evals when justified.\n\nAcceptance: the final summary records what changed, what was verified, PR/merge result when applicable, final branch, clean worktree, and any real blocker with evidence.\n\nStop conditions: stop when the task is complete, a real blocker is proven, or the planned scope would require unrelated work. Avoid optimizing beyond the bounded task.\n\nNon-goals: do not expand scope, redo already-satisfactory work, install target-project dependencies just to satisfy bot policy, or merge unless the configured project policy allows it.\n\nConfirm only if this plan matches your intent.",
  langUsage: "Usage: /lang <en|zh|zh-TW|yue|ja|es>",
  sessionsRestoreHint: "Use `/sessions <id-prefix>` to resume",
  opportunityProjectFallback: "Project",
  opportunityProjectCount: (n) => `${n} projects`,
  opportunityDigestDelegable: (project, n) =>
    `${project} · ${n} suggestion${n === 1 ? "" : "s"}\nContinue the discussion; when you are ready to execute, delegate with Autopilot.`,
  opportunityDigestDiscussFirst: (project, n) =>
    `${project} · ${n} suggestion${n === 1 ? "" : "s"}\nDiscuss first, then delegate once the scope is clear.`,
  btnOpportunityContinueDiscuss: "Continue discussion",
  btnOpportunityDiscussAll: "Discuss all",
  btnOpportunityShow: "Details",
  btnOpportunityDiscuss: "Discuss",
  btnOpportunityDismiss: "Skip",
  opportunityNotFound: (ids) => `Opportunity not found: ${ids}`,
  opportunitySkipped: (n) => `Skipped ${n} opportunit${n === 1 ? "y" : "ies"}.`,
  opportunitySkippedMissing: (n, ids) =>
    `Skipped ${n} opportunit${n === 1 ? "y" : "ies"}. Missing: ${ids}`,
  opportunityMixedProjects: "Cannot discuss mixed-project opportunities together.",
  opportunityCannotOpenProject: (reason) => `Cannot open project for discussion: ${reason}`,
  opportunityDiscussionStarted: (n) => `Discussing ${n} opportunit${n === 1 ? "y" : "ies"}.`,
  opportunityAutomationConflict: (taskKind, runId, supervisorSession) =>
    `This project is running an automation task, so discussion is temporarily blocked. Try again after the task finishes.\n\nTask: ${taskKind}\nRun: ${runId}\nSupervisor: ${supervisorSession}`,
  opportunityQueueBusy:
    "The project agent is processing work or has queued messages, so discussion is temporarily blocked. Try again after the current task finishes.",
  opportunityGitStatusUnknown: (reason) =>
    `Cannot confirm project git status, so discussion is temporarily blocked.\n${reason}`,
  opportunityDirtyWorktree: (preview) =>
    `The project worktree is dirty, so discussion is temporarily blocked. Resolve the existing changes first.\n\n${preview}`,
  btnApDelegate: "🚀 Continue via supervisor",
  btnApDelegateNow: "🚀 Delegate now",
  btnApReviewPlan: "📋 Review plan first",
  btnApConfirmDelegate: "✅ Confirm delegation",
  btnApCancelDelegate: "⛔ Cancel delegate",
  btnApQueue: `${UI_ICONS.tone.queue} View queue`,
  btnApBack: "↩︎ Back",
  autopilotQueueTitle: `${UI_ICONS.tone.queue} Supervisor queue`,
  noLogsContext: "No current session. Select a project or specify a trace (/logs <traceId>).",

  // ── group binding (Feishu) ──
  groupBoundWelcome: (label, path) =>
    `🎉 Group bound to **${label}**\n\`${path}\`\n\nJust type — no @ needed.`,
  groupCreateFailed: (msg) =>
    `❌ Failed to create group: ${msg}\n\nMake sure the bot has the \`im:chat\` scope.`,
  groupBindOnlyInGroup: "`/bind` only works inside a group. In a private chat use `/newgroup`.",
  groupUnbindOnlyInGroup: "`/unbind` only works inside a group.",
  groupNewGroupOnlyInP2p: "`/newgroup` only works in a private chat with the bot.",
  groupRestored: (label) => `🔄 Restored this group → **${label}**.`,
  groupMissingPath: (label) =>
    `⚠️ The workspace for **${label}** is gone from disk. Use \`/rebind <path|name>\` to point this group somewhere else.`,
  groupUnbound: "🔓 This group is no longer bound to a workspace.",
  groupNotBound: "This group isn't bound to a workspace. Use `/bind <path|name>`.",
  groupTargetUsage: "Usage: `<command> <absolute path | ~/path | workspace name>`",
  btnGroupMenu: "🗂 Project groups",
  btnMakeGroup: "🆕 New group",
  btnBindHere: "🔗 Bind",
  btnRebindGroup: "🔁 Rebind",
  btnUnbindGroup: "🔓 Unbind",
  btnRestoreGroup: "🔄 Restore",
  groupPickerTitle: "🆕 New project group — pick a project",
  groupBindPickerTitle: "🔗 Bind this group — pick a project",
  groupBoundCardTitle: (label) => `🗂 This group is bound to: ${label}`,
  groupMenuNoProjects:
    "No recent projects yet. Add one in a private chat with `/add_project <path>`.",
  groupNoNewGroupProjects:
    "No regular project is eligible for a new group (already-grouped projects and independent sessions are hidden).",
  groupNoBindableProjects:
    "No regular project is available to bind. Add one in a private chat with `/add_project <path>`.",
  groupNoParallelProjects:
    "No regular project is available for a new parallel group. Add one first.",
  groupCreatedShort: (label) => `✓ Created project group "${label}" — continue in the new group.`,
  groupAlreadyExists: (label) =>
    `⚠️ Project "${label}" already has a bound group — use that one; no need to create another.`,
  groupPinnedNoSwitch: (label) =>
    `🔒 This group is pinned to "${label}" — switching projects is disabled here. Use 🗂 → Rebind to change it.`,
  groupNoRemoveInGroup:
    "🔒 Removing projects isn't allowed in a group (it affects others). Do it in a private chat with the bot.",
  groupFreePickerTitle: `${UI_ICONS.session.independent} New parallel project group (creates an independent session)`,
  groupOverviewTitle: "🗂 Project groups",
  groupOverviewExisting: "Existing project groups:",
  groupOverviewNoGroups: "No project groups yet.",
  groupOverviewItem: (label, path) => `• **${label}** — \`${path}\``,
  btnFreeGroup: `${UI_ICONS.session.independent} New parallel group`,
  freeGroupCreated: (label) => `${UI_ICONS.session.independent} Parallel group "${label}" created`,
};
